// The ledger, and the lock order every write in this server keeps.
//
// A write allocates its document id first (`allocateId`, which locks the `sequences` row) and
// posts its moves second (`postMoves`, which locks balance rows) — never the other way round.
// Two writes that need both therefore take those locks in the same sequence, so neither can sit
// holding one while it waits for the other. `modules/pos/service.ts` is written that way; every
// write added after it must be too.
import { sql } from "drizzle-orm";
import { round3 } from "@rch/domain";
import type { Db } from "../db/client.js";
import { stockBalances, stockMoves } from "../db/schema/index.js";
import type { Tx } from "./db.js";

export type MoveKind = (typeof stockMoves.$inferInsert)["kind"];
export type Move = { loc: string; it: string; qty: number; kind: MoveKind; refType: string; refId: string; by?: string; at?: Date };

/**
 * The one door to the ledger. Locks every (loc, item) balance the batch touches, in a fixed
 * order so two writers cannot deadlock, appends the moves, then adds the deltas to the cache.
 */
export async function postMoves(tx: Tx, moves: Move[]): Promise<void> {
  if (moves.length === 0) return;
  // Location -> item -> delta, nested rather than keyed by a joined string: an item key is
  // whatever the central store typed, so any separator could also appear inside a key and fold
  // two different pairs into one. A nested map has nothing to collide.
  const byLoc = new Map<string, Map<string, number>>();
  for (const m of moves) {
    const items = byLoc.get(m.loc) ?? new Map<string, number>();
    items.set(m.it, round3((items.get(m.it) ?? 0) + m.qty));
    byLoc.set(m.loc, items);
  }
  // A fixed order across every writer, so two batches touching the same pair cannot deadlock.
  const ordered = [...byLoc.keys()].sort().flatMap((loc) =>
    [...byLoc.get(loc)!.keys()].sort().map((it) => ({ loc, it, delta: byLoc.get(loc)!.get(it)! })));
  for (const { loc, it } of ordered) {
    await tx.insert(stockBalances).values({ loc, itemKey: it, onHand: 0 }).onConflictDoNothing();
    await tx.execute(sql`select 1 from stock_balances where loc = ${loc} and item_key = ${it} for update`);
  }
  await tx.insert(stockMoves).values(moves.map((m) => ({
    loc: m.loc, itemKey: m.it, qty: round3(m.qty), kind: m.kind, refType: m.refType, refId: m.refId, byUser: m.by, at: m.at,
  })));
  for (const { loc, it, delta } of ordered) {
    await tx.execute(sql`update stock_balances set on_hand = round(on_hand + ${delta}::numeric, 3), updated_at = now() where loc = ${loc} and item_key = ${it}`);
  }
}

/**
 * Recompute every balance from the moves. Proves the cache; also the recovery path.
 *
 * It zeroes the rows it finds and adds the moves back on top — it never deletes them. A row's
 * presence is itself information: it means "this location carries the line", and the stock
 * screens read it that way, showing a dash where there is no row and 0 where there is a dry one
 * (M12 — `UI/src/roles/buyer/Inventory.tsx`, `manager/ItemsStock.tsx`, `counter/Stock.tsx`).
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
