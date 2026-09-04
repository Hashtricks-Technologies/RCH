// Goods receipt: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Grn, PoStatus, PurchaseOrder } from "@rch/contract";
import { round3, type ClaimSrc } from "@rch/domain";
import { grns, poLines, poLineSources, priceListItems, purchaseOrders, requisitionLines, requisitions, users } from "../../db/schema/index.js";
import type { Tx } from "../../lib/db.js";
import { readHistory } from "../../lib/history.js";
import { iso } from "../../lib/time.js";

export type PoRow = typeof purchaseOrders.$inferSelect;
export type NewGrn = typeof grns.$inferInsert;
export type GrnRow = typeof grns.$inferSelect;
/** One purchase-order line as a receipt reads it: what was ordered and what earlier
 *  instalments already booked in. `rate` rides along because the wire shape carries it. */
export type PoLineRow = { it: string; qty: number; rate: number; recv: number; rejected: number };

export const grnRepo = {
  /**
   * A locking read. Every status transition reads its own row `for update` (spec §5.1), and
   * here the lock does a second job: it is what serialises two receipts against one order, so
   * the instalment count `grnCount` reads cannot be read twice and numbered the same.
   */
  async head(tx: Tx, id: string): Promise<PoRow | undefined> {
    const [o] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for("update");
    return o;
  },

  /** The order as it was written, in the buyer's own line order. */
  async lines(tx: Tx, id: string): Promise<PoLineRow[]> {
    const rows = await tx.select().from(poLines).where(eq(poLines.poId, id)).orderBy(asc(poLines.lineNo));
    return rows.map((l) => ({ it: l.itemKey, qty: l.qty, rate: l.rate, recv: l.receivedQty, rejected: l.rejectedQty }));
  },

  /** Line number -> the requisition claims that funded it, in the order the buyer added them.
   *  `releaseClaim` walks that order backwards, so the sequence is part of the answer. */
  async sources(tx: Tx, id: string): Promise<Map<number, ClaimSrc[]>> {
    const rows = await tx.select().from(poLineSources).where(eq(poLineSources.poId, id))
      .orderBy(asc(poLineSources.lineNo), asc(poLineSources.seq));
    const by = new Map<number, ClaimSrc[]>();
    for (const r of rows) (by.get(r.lineNo) ?? by.set(r.lineNo, []).get(r.lineNo)!).push({ prq: r.requisitionId, line: r.requisitionLineNo, qty: r.qty });
    return by;
  },

  /** How many GRN rows this order already carries. Spec §7.3 numbers a goods receipt by the
   *  instalment count for its own order, not from a sequence — which is why `IdKind` has no
   *  "grn". Read under the order's `for update` lock, which is what serialises two receipts. */
  async grnCount(tx: Tx, poId: string): Promise<number> {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(grns).where(eq(grns.poId, poId));
    return row?.n ?? 0;
  },

  /** The receipt documents themselves. `.returning()` hands back what the database stored — the
   *  defaulted `at` included — so the wire shape and the ledger's timestamps cannot drift. */
  async insertGrns(tx: Tx, rows: readonly NewGrn[]): Promise<GrnRow[]> {
    if (rows.length === 0) return [];
    return tx.insert(grns).values([...rows]).returning();
  },

  /** What this line has now taken in, cumulative — the receipt hands the whole figure, not a delta. */
  async setLineReceipt(tx: Tx, poId: string, lineNo: number, patch: { receivedQty: number; rejectedQty: number }): Promise<void> {
    await tx.update(poLines).set({ receivedQty: patch.receivedQty, rejectedQty: patch.rejectedQty })
      .where(and(eq(poLines.poId, poId), eq(poLines.lineNo, lineNo)));
  },

  async setStatus(tx: Tx, id: string, patch: { status: PoStatus; receivedAt?: Date; shortNote?: string }): Promise<void> {
    await tx.update(purchaseOrders).set({
      status: patch.status, updatedAt: new Date(),
      ...(patch.receivedAt ? { receivedAt: patch.receivedAt } : {}),
      ...(patch.shortNote !== undefined ? { shortNote: patch.shortNote } : {}),
    }).where(eq(purchaseOrders.id, id));
  },

  /** The list-A shelf price for these items, for the printed-MRP check. */
  async listAPrices(tx: Tx, itemKeys: readonly string[]): Promise<Record<string, number>> {
    if (itemKeys.length === 0) return {};
    const rows = await tx.select({ itemKey: priceListItems.itemKey, price: priceListItems.price })
      .from(priceListItems).where(and(eq(priceListItems.list, "A"), inArray(priceListItems.itemKey, [...itemKeys])));
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.price]));
  },

  /** `for update` on the named requisitions, ascending id — the document lock order the header
   *  of `lib/ledger.ts` states. The order's own row is already held by the caller. One statement
   *  per id rather than one `in (…)`, so the sequence the locks are taken in is the sequence
   *  written here and not whatever the planner chose. (The purchaseorders module has its own
   *  copy of this pair; the arithmetic they both drive is one implementation, in @rch/domain.) */
  async lockRequisitions(tx: Tx, ids: readonly string[]): Promise<void> {
    for (const id of [...new Set(ids)].sort()) {
      await tx.select({ id: requisitions.id }).from(requisitions).where(eq(requisitions.id, id)).for("update");
    }
  },

  /** Move the claim on each requisition line: `sign` 1 when an order takes demand off the
   *  procurement list, −1 when it gives the demand back. Added in SQL, under the head lock the
   *  caller took, so the read and the write cannot be split by another writer. */
  async addOrdered(tx: Tx, deltas: readonly ClaimSrc[], sign: 1 | -1): Promise<void> {
    for (const d of deltas) {
      await tx.update(requisitionLines)
        .set({ orderedQty: sql`round(${requisitionLines.orderedQty} + ${round3(sign * d.qty)}::numeric, 3)` })
        .where(and(eq(requisitionLines.requisitionId, d.prq), eq(requisitionLines.lineNo, d.line)));
    }
  },

  /** Who signed it, for the history row and the receipt's `by`. */
  async userName(tx: Tx, id: string): Promise<string> {
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },

  /** The wire shape `readPurchaseOrders` produces, for the one order a write has just changed. */
  async wire(tx: Tx, id: string): Promise<PurchaseOrder> {
    const [head] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
    if (!head) throw new Error(`purchase order ${id} vanished mid-transaction`);
    const lines = await tx.select().from(poLines).where(eq(poLines.poId, id)).orderBy(asc(poLines.lineNo));
    const srcs = await grnRepo.sources(tx, id);
    const hist = await readHistory(tx, "purchase_order", id);
    return {
      id: head.id, vendor: head.vendorId, at: iso(head.at),
      lines: lines.map((l) => ({ it: l.itemKey, qty: l.qty, rate: l.rate, src: srcs.get(l.lineNo) ?? [], recv: l.receivedQty, rejected: l.rejectedQty })),
      st: head.status, eta: head.eta ?? "", needsApproval: head.needsApproval, hist,
      ...(head.shortNote == null ? {} : { shortNote: head.shortNote }),
      ...(head.receivedAt ? { recv: iso(head.receivedAt) } : {}),
    };
  },

  /** The wire shape `readGrns` produces, for the instalment just written — in id order, which
   *  is instalment order, because the number carries the position. */
  async wireGrns(tx: Tx, ids: readonly string[]): Promise<Grn[]> {
    if (ids.length === 0) return [];
    const rows = await tx.select().from(grns).where(inArray(grns.id, [...ids])).orderBy(asc(grns.id));
    const names = new Map<string, string>();
    for (const g of rows) if (g.byUser && !names.has(g.byUser)) names.set(g.byUser, await grnRepo.userName(tx, g.byUser));
    return rows.map((g) => ({
      id: g.id, po: g.poId, it: g.itemKey, qty: g.acceptedQty, rejected: g.rejectedQty, batch: g.batchNo,
      mrp: g.mrp, mfg: g.mfg, exp: g.exp, dc: g.dcNo, invoice: g.invoiceNo, invDate: g.invoiceDate ?? "",
      at: iso(g.at), by: g.byUser ? names.get(g.byUser) ?? g.byUser : "",
    }));
  },
};
