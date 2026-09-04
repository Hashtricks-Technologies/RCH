// Purchase orders: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
//
// This module and `grn` split `po_lines` by column: everything here writes `qty`, `rate` and a
// line's sources and never `received_qty`/`rejected_qty`; the receipt module writes those two
// and never these. Both write the order's `status`, under the same `head()` lock.
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { PoStatus, PrqStatus, PurchaseOrder } from "@rch/contract";
import { round3, type ClaimSrc } from "@rch/domain";
import type { Tx } from "../../lib/db.js";
import { readHistory } from "../../lib/history.js";
import { iso } from "../../lib/time.js";
import { poLines, poLineSources, purchaseOrders, rateContracts, requisitionLines, requisitions, users, vendors } from "../../db/schema/index.js";

export type PoRow = typeof purchaseOrders.$inferSelect;
export type NewPo = typeof purchaseOrders.$inferInsert;
export type VendorRow = typeof vendors.$inferSelect;
/** One line as every rule in this module reads it — what was ordered, at what rate, and what
 *  has already arrived against it (read-only here; `grn` is what moves it). */
export type PoLineRow = { it: string; qty: number; rate: number; recv: number; rejected: number };
export type PrqLines = { status: PrqStatus; lines: { it: string; appr: number; ordered: number }[] };
export type PoPatch = { status?: PoStatus; shortNote?: string; needsApproval?: boolean; eta?: string; vendorId?: string; at?: Date };

/** A nullable column reads back as null; dropping the key keeps the wire shape the snapshot's
 *  reader produces (snapshot/readers/documents.ts), so a screen cannot tell the two apart. */
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const purchaseOrdersRepo = {
  /**
   * The head, read **for update**. Every write in this module but `create` opens here, so the
   * order's row is held to the end of the transaction: two buyers pressing Send together queue
   * on this line and the second reads the status the first committed. It is also the first half
   * of the phase's document lock order — the order's row before any requisition's.
   */
  async head(tx: Tx, id: string): Promise<PoRow | undefined> {
    const [o] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).for("update");
    return o;
  },

  async lines(tx: Tx, id: string): Promise<PoLineRow[]> {
    const rows = await tx.select().from(poLines).where(eq(poLines.poId, id)).orderBy(asc(poLines.lineNo));
    return rows.map((l) => ({ it: l.itemKey, qty: l.qty, rate: l.rate, recv: l.receivedQty, rejected: l.rejectedQty }));
  },

  /** Each line's sources, in the order the buyer picked them — which is the order
   *  `releaseClaim` walks backwards. */
  async sources(tx: Tx, id: string): Promise<Map<number, ClaimSrc[]>> {
    const rows = await tx.select().from(poLineSources).where(eq(poLineSources.poId, id))
      .orderBy(asc(poLineSources.lineNo), asc(poLineSources.seq));
    const by = new Map<number, ClaimSrc[]>();
    for (const r of rows) {
      const at = by.get(r.lineNo) ?? [];
      at.push({ prq: r.requisitionId, line: r.requisitionLineNo, qty: r.qty });
      by.set(r.lineNo, at);
    }
    return by;
  },

  async vendor(tx: Tx, id: string): Promise<VendorRow | undefined> {
    const [v] = await tx.select().from(vendors).where(eq(vendors.id, id));
    return v;
  },

  /** `for update` on the named requisitions, ascending id — the document lock order this phase
   *  wrote into lib/ledger.ts's header. One statement, ordered, so two writers holding two
   *  requisitions between them cannot each hold the one the other wants. */
  async lockRequisitions(tx: Tx, ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids)].sort();
    if (unique.length === 0) return;
    await tx.select({ id: requisitions.id }).from(requisitions)
      .where(inArray(requisitions.id, unique)).orderBy(asc(requisitions.id)).for("update");
  },

  /** Each named requisition with its status and its lines, for the pending check. */
  async prqLines(tx: Tx, ids: readonly string[]): Promise<Map<string, PrqLines>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const heads = await tx.select().from(requisitions).where(inArray(requisitions.id, unique));
    const lines = await tx.select().from(requisitionLines)
      .where(inArray(requisitionLines.requisitionId, unique)).orderBy(asc(requisitionLines.lineNo));
    return new Map(heads.map((h) => [h.id, {
      status: h.status,
      lines: lines.filter((l) => l.requisitionId === h.id).map((l) => ({ it: l.itemKey, appr: l.approvedQty, ordered: l.orderedQty })),
    }]));
  },

  /** Move `ordered_qty` on the named requisition lines. This is the only thing that adds to or
   *  takes from the procurement list, which is derived (approved less ordered) and stored
   *  nowhere. Call it under `lockRequisitions`, never without. */
  async addOrdered(tx: Tx, deltas: readonly ClaimSrc[], sign: 1 | -1): Promise<void> {
    for (const d of deltas) {
      await tx.update(requisitionLines)
        .set({ orderedQty: sql`round(${requisitionLines.orderedQty} + ${sign * d.qty}::numeric, 3)` })
        .where(and(eq(requisitionLines.requisitionId, d.prq), eq(requisitionLines.lineNo, d.line)));
    }
  },

  async insert(tx: Tx, row: NewPo): Promise<void> {
    await tx.insert(purchaseOrders).values(row);
  },

  /**
   * A draft's lines and their sources, rewritten wholesale.
   *
   * Deleting and re-inserting keeps `line_no` equal to the array index the wire shape carries,
   * which is what PATCH/DELETE address and what `grns.po_line_no` points at. Shifting numbers in
   * place (`line_no = line_no - 1`) would transiently collide with the primary key unless it
   * were deferrable; a rewrite under the order's own row lock needs nothing. Only a Draft ever
   * reaches here, and a Draft has no goods receipt pointing at a line.
   */
  async writeLines(tx: Tx, id: string, lines: readonly { it: string; qty: number; rate: number; src: ClaimSrc[] }[]): Promise<void> {
    await tx.delete(poLineSources).where(eq(poLineSources.poId, id));
    await tx.delete(poLines).where(eq(poLines.poId, id));
    if (lines.length === 0) return;
    await tx.insert(poLines).values(lines.map((l, lineNo) => ({
      poId: id, lineNo, itemKey: l.it, qty: round3(l.qty), rate: Math.round(l.rate * 100) / 100,
    })));
    const srcs = lines.flatMap((l, lineNo) => l.src.map((x, seq) => ({
      poId: id, lineNo, seq, requisitionId: x.prq, requisitionLineNo: x.line, qty: round3(x.qty),
    })));
    if (srcs.length) await tx.insert(poLineSources).values(srcs);
  },

  async setStatus(tx: Tx, id: string, patch: PoPatch): Promise<void> {
    await tx.update(purchaseOrders).set({ ...patch, updatedAt: new Date() }).where(eq(purchaseOrders.id, id));
  },

  /** History is signed with a name, not an id: it is read on a screen. */
  async userName(tx: Tx, id: string): Promise<string> {
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },

  /** Every live rate this vendor has for these items, on the given date. A contract whose window
   *  has closed does not price an order, however active its flag says it is. */
  async activeContractRates(tx: Tx, vendorId: string, itemKeys: readonly string[], on: string): Promise<Record<string, number>> {
    if (itemKeys.length === 0) return {};
    const rows = await tx.select({ itemKey: rateContracts.itemKey, rate: rateContracts.rate })
      .from(rateContracts)
      .where(and(eq(rateContracts.vendorId, vendorId), eq(rateContracts.active, true),
        inArray(rateContracts.itemKey, [...itemKeys]),
        lte(rateContracts.validFrom, on), gte(rateContracts.validTo, on)));
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.rate]));
  },

  /** One order in the shape the snapshot hands out, for a service that has just changed it. */
  async wire(tx: Tx, id: string): Promise<PurchaseOrder> {
    const [o] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
    if (!o) throw new Error(`purchase order ${id} disappeared inside its own transaction`);
    const lines = await this.lines(tx, id);
    const src = await this.sources(tx, id);
    const hist = await readHistory(tx, "purchase_order", id);
    return strip({
      id: o.id, vendor: o.vendorId, at: iso(o.at),
      lines: lines.map((l, lineNo) => ({ it: l.it, qty: l.qty, rate: l.rate, src: src.get(lineNo) ?? [], recv: l.recv, rejected: l.rejected })),
      st: o.status, eta: o.eta ?? "", needsApproval: o.needsApproval, shortNote: o.shortNote ?? undefined,
      recv: o.receivedAt ? iso(o.receivedAt) : undefined, hist,
    });
  },
};
