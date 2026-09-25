// The ledger, and the lock order every write in this server keeps.
//
// A write allocates its document id first (`allocateId`, which locks the `sequences` row) and
// posts its moves second (`postMoves`, which locks balance rows) - never the other way round.
// Two writes that need both therefore take those locks in the same sequence, so neither can sit
// holding one while it waits for the other. `modules/tickets/service.ts`'s `transfer` is written
// that way; every write added after it must be too.
//
// The counter sale is the one deliberate exception, and it is safe for a reason no other write
// can borrow: `allocateId(tx, "bill"` has exactly one caller, so nobody else ever takes the
// `bill` sequence row at all, and a deadlock needs two writers taking the same two locks in
// opposite orders. `modules/pos/service.ts` takes its number last, after the shelves are locked
// and the cover check has passed, so a sale queued behind a shelf is not also sitting on the row
// every till in the hospital draws its bill number from. Read the comment there before copying it.
//
// Document rows come before both, and from Phase 5 they have an order of their own: **the
// purchase-order row is locked before any requisition row, and requisition rows are locked in
// ascending requisition_id order** (`foldClaims` in @rch/domain sorts them for you). A purchase
// order and the requisitions it claims against are locked together whenever a claim moves -
// creating, shrinking, removing, cancelling or closing short - and `createPo` is the single
// exception that proves the rule: it locks requisition rows while holding no purchase-order
// lock, which is safe only because it is creating the order and can never afterwards reach for
// an existing one. No cycle exists as long as nothing else does that.
import { sql } from "drizzle-orm";
import type { ItemType } from "@rch/contract";
import { round3, usedOnArrival } from "@rch/domain";
import type { Db } from "../db/client.js";
import { stockBalances, stockMoves } from "../db/schema/index.js";
import type { Tx } from "./db.js";

export type MoveKind = (typeof stockMoves.$inferInsert)["kind"];
/** `reverses` is the id of the move this one undoes - a same-day bill void posts one reversal
 *  per line of the sale it takes back, each pointing at the row it cancels out. The ledger is
 *  append-only (migration 0002 says so in the database), so an undo is another move, and this
 *  is the column that says which one it answers. Every other kind of move leaves it unset. */
export type Move = { loc: string; it: string; qty: number; kind: MoveKind; refType: string; refId: string; by?: string; at?: Date; reverses?: number };

/**
 * The kitchen's raw materials and packaging are used the moment they land (`usedOnArrival`,
 * @rch/domain): every positive move that lands one at the kitchen is followed by an equal
 * `production_consume` move under the same document, so the kitchen's balance of the line never
 * moves off zero while the ledger still says what was issued, when and on what. Every write that
 * can land stock - a ticket received, a count-up, a new product's opening figure - hands its
 * moves through this before `postMoves`, and both halves post in the one call, under one lock.
 */
export function withUseOnArrival(items: Readonly<Record<string, { t: ItemType }>>, moves: readonly Move[]): Move[] {
  return moves.flatMap((m) => {
    const item = items[m.it];
    return item && m.qty > 0 && usedOnArrival(item.t, m.loc) ? [m, { ...m, qty: -m.qty, kind: "production_consume" as const }] : [m];
  });
}

/**
 * Take the balance row locks for these (loc, item) pairs, creating a zero row where none
 * exists, in one fixed order across every writer so two batches cannot deadlock. `postMoves`
 * calls it before appending; a path that only reserves - issuing a ticket, a shop transfer -
 * calls it before reading `on_hand`, because a reservation is a promise against a balance and
 * two promises made from the same read are the same stock promised twice.
 *
 * Duplicates are folded and the pairs are visited in (loc, item) order. Nested rather than
 * keyed by a joined string, for the reason postMoves gives: no separator can collide.
 */
export async function lockBalances(tx: Tx, cells: readonly { loc: string; it: string }[]): Promise<void> {
  const byLoc = new Map<string, Set<string>>();
  for (const c of cells) (byLoc.get(c.loc) ?? byLoc.set(c.loc, new Set()).get(c.loc)!).add(c.it);
  for (const loc of [...byLoc.keys()].sort()) {
    for (const it of [...byLoc.get(loc)!].sort()) {
      await tx.insert(stockBalances).values({ loc, itemKey: it, onHand: 0 }).onConflictDoNothing();
      await tx.execute(sql`select 1 from stock_balances where loc = ${loc} and item_key = ${it} for update`);
    }
  }
}

/**
 * The one door to the ledger. Locks every (loc, item) balance the batch touches, in a fixed
 * order so two writers cannot deadlock, appends the moves, then adds the deltas to the cache.
 *
 * A move whose quantity rounds away to nothing at three decimals is dropped before any of that.
 * A move of zero is not a movement - `stock_moves_qty_ck` (migration 0008) says so - and a
 * fraction that rounds to 0.000 must not turn a real write into a 500 with no words in it.
 * Dropped row by row rather than by cell, so a crumb never takes the real move beside it down;
 * the fold below then runs over what is left, and a cell no surviving move touches is never
 * locked, because `lockBalances` creates the row it locks and a shelf that moved nothing would
 * read as "carried at zero" on every stock screen from then on (M12).
 */
export async function postMoves(tx: Tx, moves: Move[]): Promise<void> {
  const real = moves.filter((m) => round3(m.qty) !== 0);
  if (real.length === 0) return;
  // Location -> item -> delta, nested rather than keyed by a joined string: an item key is
  // whatever the central store typed, so any separator could also appear inside a key and fold
  // two different pairs into one. A nested map has nothing to collide.
  const byLoc = new Map<string, Map<string, number>>();
  for (const m of real) {
    const items = byLoc.get(m.loc) ?? new Map<string, number>();
    items.set(m.it, round3((items.get(m.it) ?? 0) + m.qty));
    byLoc.set(m.loc, items);
  }
  // A fixed order across every writer, so two batches touching the same pair cannot deadlock.
  const ordered = [...byLoc.keys()].sort().flatMap((loc) =>
    [...byLoc.get(loc)!.keys()].sort().map((it) => ({ loc, it, delta: byLoc.get(loc)!.get(it)! })));
  await lockBalances(tx, ordered);
  await tx.insert(stockMoves).values(real.map((m) => ({
    loc: m.loc, itemKey: m.it, qty: round3(m.qty), kind: m.kind, refType: m.refType, refId: m.refId, byUser: m.by, at: m.at,
    reversesId: m.reverses,
  })));
  for (const { loc, it, delta } of ordered) {
    await tx.execute(sql`update stock_balances set on_hand = round(on_hand + ${delta}::numeric, 3), updated_at = now() where loc = ${loc} and item_key = ${it}`);
  }
}

/**
 * Recompute every balance from the moves. Proves the cache; also the recovery path.
 *
 * It zeroes the rows it finds and adds the moves back on top - it never deletes them. A row's
 * presence is itself information: it means "this location carries the line", and the stock
 * screens read it that way, showing a dash where there is no row and 0 where there is a dry one
 * (M12 - `UI/src/roles/buyer/Inventory.tsx`, `manager/ItemsStock.tsx`, `counter/Stock.tsx`).
 * That is why the seed writes a zero row directly for a listed-but-empty item
 * (`db/seed.ts`, `seedOpeningStock`), and why a rebuild that started from `delete` would quietly
 * drop those lines off the shelf list instead of showing them as empty.
 */
export async function rebuildBalances(db: Db): Promise<{ rows: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table stock_balances in exclusive mode`);
    await tx.execute(sql`update stock_balances set on_hand = 0, updated_at = now()`);
    const r = await tx.execute(sql`
      insert into stock_balances (loc, item_key, on_hand, updated_at)
      select loc, item_key, round(sum(qty), 3), now() from stock_moves group by loc, item_key
      on conflict (loc, item_key) do update set on_hand = excluded.on_hand, updated_at = now()`);
    return { rows: r.rowCount ?? 0 };
  });
}
