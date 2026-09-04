// Pos: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { OvrMap, Prices, RsvMap, StockMap } from "@rch/domain";
import type { Tx } from "../../lib/db.js";
import type { BillLineRow, BillRow } from "../../lib/wire.js";
import { availabilityOverrides, billLines, bills, locationItems, priceListItems, reservations, stockBalances, users } from "../../db/schema/index.js";

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

  /** Both lists: which one a location charges from is the master's business (`priceOf`). */
  async prices(tx: Tx): Promise<Prices> {
    const rows = await tx.select().from(priceListItems);
    const out: Prices = { A: {}, B: {} };
    for (const r of rows) out[r.list][r.itemKey] = r.price;
    return out;
  },

  /** The counter's menu, as a membership test. */
  async menuAt(tx: Tx, loc: string): Promise<Set<string>> {
    const rows = await tx.select({ itemKey: locationItems.itemKey }).from(locationItems).where(eq(locationItems.loc, loc));
    return new Set(rows.map((r) => r.itemKey));
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

  /** Read back after `postMoves` has taken the locks — the only number a sale may trust. */
  async onHandAt(tx: Tx, loc: string, itemKeys: string[]): Promise<Record<string, number>> {
    if (itemKeys.length === 0) return {};
    const rows = await tx.select().from(stockBalances)
      .where(and(eq(stockBalances.loc, loc), inArray(stockBalances.itemKey, itemKeys))).orderBy(asc(stockBalances.itemKey));
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.onHand]));
  },

  /**
   * What this staff member has already put on credit inside the window. Deliberately unscoped
   * by location: the ceiling belongs to the person, so a bill they ran up at the kiosk counts
   * against them at the coffee shop.
   */
  async staffCreditTaken(tx: Tx, payerId: string, since: Date): Promise<number> {
    const [row] = await tx.select({ taken: sql<string>`coalesce(round(sum(${bills.total}), 2), 0)` })
      .from(bills)
      .where(and(eq(bills.payerKind, "staff"), eq(bills.payerId, payerId), gte(bills.at, since)));
    return Number(row?.taken ?? 0);
  },
};
