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
  const keys = [...new Set(moves.map((m) => `${m.loc} ${m.it}`))].sort();
  for (const k of keys) {
    const [loc, it] = k.split(" ");
    await tx.insert(stockBalances).values({ loc, itemKey: it, onHand: 0 }).onConflictDoNothing();
    await tx.execute(sql`select 1 from stock_balances where loc = ${loc} and item_key = ${it} for update`);
  }
  await tx.insert(stockMoves).values(moves.map((m) => ({
    loc: m.loc, itemKey: m.it, qty: round3(m.qty), kind: m.kind, refType: m.refType, refId: m.refId, byUser: m.by, at: m.at,
  })));
  const delta = new Map<string, number>();
  for (const m of moves) { const k = `${m.loc} ${m.it}`; delta.set(k, round3((delta.get(k) ?? 0) + m.qty)); }
  for (const [k, d] of delta) {
    const [loc, it] = k.split(" ");
    await tx.execute(sql`update stock_balances set on_hand = round(on_hand + ${d}::numeric, 3), updated_at = now() where loc = ${loc} and item_key = ${it}`);
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
