import { sql } from "drizzle-orm";
import { round3 } from "@rch/domain";
import type { Db } from "../db/client.js";
import { stockBalances, stockMoves } from "../db/schema/index.js";
import type { Tx } from "./db.js";

export type MoveKind = (typeof stockMoves.$inferInsert)["kind"];
export type Move = { loc: string; it: string; qty: number; kind: MoveKind; refType: string; refId: string; by?: string; at?: Date };

/** Only ever a map key inside this file — the (loc, item) pair travels with it, never re-split out of it. */
const SEP = " ";

/**
 * The one door to the ledger. Locks every (loc, item) balance the batch touches, in a fixed
 * order so two writers cannot deadlock, appends the moves, then adds the deltas to the cache.
 */
export async function postMoves(tx: Tx, moves: Move[]): Promise<void> {
  if (moves.length === 0) return;
  // The map is keyed by a string so a repeated (loc, item) folds into one lock and one delta,
  // but the pair itself is carried alongside: an item key the central store typed may contain
  // the separator, and splitting the key back apart would silently move the wrong balance.
  const cells = new Map<string, { loc: string; it: string; delta: number }>();
  for (const m of moves) {
    const k = `${m.loc}${SEP}${m.it}`;
    const cell = cells.get(k) ?? { loc: m.loc, it: m.it, delta: 0 };
    cell.delta = round3(cell.delta + m.qty);
    cells.set(k, cell);
  }
  // A fixed order across every writer, so two batches touching the same pair cannot deadlock.
  const ordered = [...cells.keys()].sort().map((k) => cells.get(k)!);
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

/** Recompute every balance from the moves. Proves the cache; also the recovery path. */
export async function rebuildBalances(db: Db): Promise<{ rows: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`lock table stock_balances in exclusive mode`);
    await tx.execute(sql`delete from stock_balances`);
    const r = await tx.execute(sql`
      insert into stock_balances (loc, item_key, on_hand, updated_at)
      select loc, item_key, round(sum(qty), 3), now() from stock_moves group by loc, item_key`);
    return { rows: r.rowCount ?? 0 };
  });
}
