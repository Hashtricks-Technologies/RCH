// Pos: SQL only. No rules, no transaction of its own - service.ts passes `tx` in.
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Tx } from "../../lib/db.js";
import type { BillLineRow, BillRow } from "../../lib/wire.js";
import { billLines, bills, settlementLines, settlements, stockMoves, users } from "../../db/schema/index.js";

/** The bill void's SQL. The sale's own reads and writes are `lib/sale.ts`'s, shared with a QR
 *  order's capture. */
export const posRepo = {
  /** A settlement nobody voided that has already closed part of this bill, if there is one. The
   *  void refuses on it: erasing the debt would leave that payment sitting against nothing. A
   *  read of the settlement tables from a module repo, which is allowed - they are not among the
   *  six protected tables, and this module never writes them. */
  async liveSettlementOf(tx: Tx, billNo: string): Promise<{ id: string } | undefined> {
    const [row] = await tx.select({ id: settlements.id }).from(settlementLines)
      .innerJoin(settlements, eq(settlements.id, settlementLines.settlementId))
      .where(and(eq(settlementLines.billNo, billNo), isNull(settlements.voidedAt)))
      .limit(1);
    return row;
  },

  async operator(tx: Tx, id: string): Promise<{ name: string; colour: string } | undefined> {
    const [u] = await tx.select({ name: users.name, colour: users.colour }).from(users).where(eq(users.id, id));
    return u;
  },

  // ---- bill void ----
  /** The bill being decided, locked first - the document, ahead of every other lock this write
   *  takes (the order every module keeps). Two managers pressing Void on the same bill queue
   *  here, and the second reads the `voided_at` the first wrote. */
  async headForUpdate(tx: Tx, no: string): Promise<BillRow | undefined> {
    const [b] = await tx.select().from(bills).where(eq(bills.no, no)).for("update");
    return b;
  },

  /**
   * The sale's own moves, the rows the void will reverse one for one.
   *
   * A read of `stock_moves` from a repo, which is allowed - what `lib/ledger.ts` owns is writing
   * it. Reading is how a reversal knows where the stock came off: the move carries its own `loc`
   * and item, so the void puts back exactly what the sale took, and a made-to-order line - which
   * took nothing - puts back nothing. Ordered by id so the reversals are written in the order the
   * sale was.
   */
  async saleMoves(tx: Tx, no: string): Promise<{ id: number; loc: string; itemKey: string; qty: number }[]> {
    return tx.select({ id: stockMoves.id, loc: stockMoves.loc, itemKey: stockMoves.itemKey, qty: stockMoves.qty })
      .from(stockMoves)
      .where(and(eq(stockMoves.refType, "bill"), eq(stockMoves.refId, no), eq(stockMoves.kind, "sale")))
      .orderBy(asc(stockMoves.id));
  },

  /** A bill's lines, in the order the counter scanned them - what `toWireBill` prints. Read
   *  back rather than kept, because a void answers with the whole bill, badged. */
  async billLines(tx: Tx, no: string): Promise<BillLineRow[]> {
    return tx.select().from(billLines).where(eq(billLines.billNo, no)).orderBy(asc(billLines.lineNo));
  },

  /** Stamp the void on the bill. Nothing else about the row changes: the lines, the total and
   *  the payer are what was printed, and a void does not rewrite history. */
  async setVoided(tx: Tx, no: string, v: { at: Date; by: string; reason: string }): Promise<BillRow> {
    const [b] = await tx.update(bills).set({ voidedAt: v.at, voidedBy: v.by, voidReason: v.reason })
      .where(eq(bills.no, no)).returning();
    return b;
  },

  // What this staff member has already put on credit is `creditTakenThisMonth` in
  // apps/api/src/lib/credit.ts now. It moved because the credit report has to answer with the
  // same number this sale refuses on, and a second copy of the query is a report that can
  // disagree with the refusal. `lockStaffCredit` above stays here: the lock belongs
  // to the sale, not to the sum, and a report that took it would put every till behind whoever
  // opened the credit screen.
};
