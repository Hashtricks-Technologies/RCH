// Reports: the two figures the browser cannot compute from its own snapshot — the central store's
// stock ledger, which needs the ledger's own moves, and a payer's credit for the calendar month,
// which needs every outlet's bills and not the till's own seven days.
//
// repo.ts: SQL only. No rules, no transaction of its own — both reads are reads, so they take
// the pool's `Db` rather than a `Tx`, and the arithmetic they feed is `ledgerRow` in
// @rch/domain. Nothing here decides anything.
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { PayerKind } from "@rch/contract";
import type { Db } from "../../db/client.js";
import * as s from "../../db/schema/index.js";

/**
 * Two aggregates for one location: what the moves before the window sum to per item, and the
 * window's own signed moves per item. Both hit `stock_moves_loc_item_at_idx` — `EXPLAIN` on
 * either must not show a sequential scan at production cardinality (spec §12, Performance).
 *
 * The two halves partition the ledger on one boundary and only one: `openingAt` takes `at < from`
 * and `movedIn` takes `at >= from`, so every move is on exactly one side of the window's edge.
 * Nothing in @rch/domain can catch that boundary being wrong, so `reports.test.ts` walks the edge
 * across a real move by a millisecond and asserts the quantity crosses from one column to the
 * other exactly once.
 */
export const reportsRepo = {
  async openingAt(db: Db, loc: string, from: Date): Promise<Map<string, number>> {
    const rows = await db.select({ it: s.stockMoves.itemKey, total: sql<string>`sum(${s.stockMoves.qty})` })
      .from(s.stockMoves).where(and(eq(s.stockMoves.loc, loc), lt(s.stockMoves.at, from))).groupBy(s.stockMoves.itemKey);
    return new Map(rows.map((r) => [r.it, Number(r.total)]));
  },

  /** The window's moves split by sign in SQL, so a busy shelf does not travel row by row. */
  async movedIn(db: Db, loc: string, from: Date, to: Date): Promise<Map<string, { recd: number; issued: number }>> {
    const rows = await db.select({
      it: s.stockMoves.itemKey,
      recd: sql<string>`sum(case when ${s.stockMoves.qty} > 0 then ${s.stockMoves.qty} else 0 end)`,
      issued: sql<string>`sum(case when ${s.stockMoves.qty} < 0 then -${s.stockMoves.qty} else 0 end)`,
    }).from(s.stockMoves)
      .where(and(eq(s.stockMoves.loc, loc), gte(s.stockMoves.at, from), lt(s.stockMoves.at, to)))
      .groupBy(s.stockMoves.itemKey);
    return new Map(rows.map((r) => [r.it, { recd: Number(r.recd), issued: Number(r.issued) }]));
  },

  /** Every item this location is carrying a line for, whether or not the window touched it. A
   *  balance row at zero means "this shelf carries this line" (M12), so it belongs on the report
   *  even when its opening, receipts and issues are all nothing. */
  async carriedAt(db: Db, loc: string): Promise<string[]> {
    const rows = await db.select({ it: s.stockBalances.itemKey }).from(s.stockBalances).where(eq(s.stockBalances.loc, loc));
    return rows.map((r) => r.it);
  },

  /** The same lookup the till makes before it takes a charge (`posRepo.payer`). Inactive payers
   *  are still resolvable here: a report on somebody who has left the hospital is a report, not a
   *  sale, and refusing it would hide the credit they still owe. */
  async payer(db: Db, kind: PayerKind, id: string) {
    const [row] = await db.select().from(s.payers).where(and(eq(s.payers.kind, kind), eq(s.payers.id, id)));
    return row ?? null;
  },
};
