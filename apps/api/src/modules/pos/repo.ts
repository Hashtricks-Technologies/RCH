// Pos: SQL only. No rules, no transaction of its own - service.ts passes `tx` in.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PayerKind } from "@rch/contract";
import type { OvrMap, Prices, RsvMap, StockMap } from "@rch/domain";
import type { Tx } from "../../lib/db.js";
import type { BillLineRow, BillRow } from "../../lib/wire.js";
import { availabilityOverrides, billLines, bills, locationItems, payers, priceListItems, reservations, settlementLines, settlements, stockBalances, stockMoves, users } from "../../db/schema/index.js";

export type NewBill = typeof bills.$inferInsert;

/**
 * A sale reads one shelf. The snapshot readers pull every location's rows because a screen
 * lists them all; a till only ever needs its own, and asking for the rest would put the whole
 * ledger behind every bill.
 */
export const posRepo = {
  async stockAt(tx: Tx, loc: string): Promise<StockMap> {
    const rows = await tx.select().from(stockBalances).where(eq(stockBalances.loc, loc));
    const byItem: Record<string, number> = {};
    for (const r of rows) byItem[r.itemKey] = r.onHand;
    return { [loc]: byItem };
  },

  /** Open reservations only: a released one is stock the counter may sell again. */
  async rsvAt(tx: Tx, loc: string): Promise<RsvMap> {
    const rows = await tx.select({ itemKey: reservations.itemKey, qty: sql<string>`round(sum(${reservations.qty}), 3)` })
      .from(reservations).where(and(eq(reservations.loc, loc), isNull(reservations.releasedAt))).groupBy(reservations.itemKey);
    return Object.fromEntries(rows.map((r) => [`${loc}:${r.itemKey}`, Number(r.qty)]));
  },

  async ovrAt(tx: Tx, loc: string): Promise<OvrMap> {
    const rows = await tx.select().from(availabilityOverrides).where(eq(availabilityOverrides.loc, loc));
    return Object.fromEntries(rows.map((r) => [`${loc}:${r.itemKey}`, r.reason]));
  },

  /** Every list: which one a location charges from is the master's business (`priceOf`). */
  async prices(tx: Tx): Promise<Prices> {
    const rows = await tx.select().from(priceListItems);
    const out: Prices = {};
    for (const r of rows) (out[r.listId] ??= {})[r.itemKey] = r.price;
    return out;
  },

  /** The counter's menu, as a membership test. */
  async menuAt(tx: Tx, loc: string): Promise<Set<string>> {
    const rows = await tx.select({ itemKey: locationItems.itemKey }).from(locationItems).where(eq(locationItems.loc, loc));
    return new Set(rows.map((r) => r.itemKey));
  },

  /**
   * The roster row a bill may be posted to. Only an active one answers: a consultant who no
   * longer visits or a staff member who has left is not somebody a new balance may be run up
   * against, and
   * the row stays for the bills already posted to it rather than being deleted.
   */
  async payer(tx: Tx, kind: PayerKind, id: string): Promise<{ name: string } | undefined> {
    const [p] = await tx.select({ name: payers.name }).from(payers)
      .where(and(eq(payers.kind, kind), eq(payers.id, id), eq(payers.active, true)));
    return p;
  },


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

  async insertBill(tx: Tx, row: NewBill): Promise<BillRow> {
    const [b] = await tx.insert(bills).values(row).returning();
    return b;
  },

  /** Sorted on the way out: `toWireBill` prints the lines in the order the counter scanned them,
   *  and RETURNING makes no promise about row order. */
  async insertBillLines(tx: Tx, billNo: string, lines: { it: string; qty: number; rate: number }[]): Promise<BillLineRow[]> {
    if (lines.length === 0) return [];
    const rows = await tx.insert(billLines).values(lines.map((l, lineNo) => ({ billNo, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate }))).returning();
    return rows.sort((a, b) => a.lineNo - b.lineNo);
  },

  /** Read back after `postMoves` has taken the locks - the only number a sale may trust. */
  async onHandAt(tx: Tx, loc: string, itemKeys: string[]): Promise<Record<string, number>> {
    if (itemKeys.length === 0) return {};
    const rows = await tx.select().from(stockBalances)
      .where(and(eq(stockBalances.loc, loc), inArray(stockBalances.itemKey, itemKeys))).orderBy(asc(stockBalances.itemKey));
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.onHand]));
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
