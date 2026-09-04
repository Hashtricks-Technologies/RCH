// Requisitions: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PrqStatus, Requisition } from "@rch/contract";
import type { Tx } from "../../lib/db.js";
import { readHistory } from "../../lib/history.js";
import { iso } from "../../lib/time.js";
import { requisitionLines, requisitions, users } from "../../db/schema/index.js";

export type RequisitionRow = typeof requisitions.$inferSelect;
export type NewRequisition = typeof requisitions.$inferInsert;
export type RequisitionLine = { it: string; qty: number; appr: number; ordered: number };

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const requisitionsRepo = {
  /** The head, read **for update**: two buyers deciding the same requisition queue on this line
   *  and the second reads the status the first committed, not the one they both started from. */
  async head(tx: Tx, id: string): Promise<RequisitionRow | undefined> {
    const [r] = await tx.select().from(requisitions).where(eq(requisitions.id, id)).for("update");
    return r;
  },

  async lines(tx: Tx, id: string): Promise<RequisitionLine[]> {
    const rows = await tx.select().from(requisitionLines)
      .where(eq(requisitionLines.requisitionId, id)).orderBy(asc(requisitionLines.lineNo));
    return rows.map((l) => ({ it: l.itemKey, qty: l.qty, appr: l.approvedQty, ordered: l.orderedQty }));
  },

  async insert(tx: Tx, row: NewRequisition): Promise<void> { await tx.insert(requisitions).values(row); },

  /** Line numbers are the order the store keeper typed them, and every reader sorts on them. */
  async insertLines(tx: Tx, id: string, lines: readonly { it: string; qty: number }[]): Promise<void> {
    if (lines.length === 0) return;
    await tx.insert(requisitionLines).values(lines.map((l, lineNo) => ({ requisitionId: id, lineNo, itemKey: l.it, qty: l.qty })));
  },

  async setDecision(tx: Tx, id: string, patch: { status: PrqStatus; approvalNote: string; approvedBy: string }): Promise<void> {
    await tx.update(requisitions).set({ ...patch, updatedAt: new Date() }).where(eq(requisitions.id, id));
  },

  /** The decision, line by line, in the order `lines()` handed them out. `ordered_qty` is not in
   *  the patch on purpose: the claim belongs to the purchase orders, not to the decision. */
  async setLineApprovals(tx: Tx, id: string, lines: readonly { appr: number; short: number }[]): Promise<void> {
    for (const [lineNo, l] of lines.entries()) {
      await tx.update(requisitionLines).set({ approvedQty: l.appr, shortQty: l.short })
        .where(and(eq(requisitionLines.requisitionId, id), eq(requisitionLines.lineNo, lineNo)));
    }
  },

  /** History is signed with a name, not an id: it is read on a screen. */
  async userName(tx: Tx, id: string): Promise<string> {
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },

  /** One requisition in the shape the snapshot hands out, for a service that just changed it. */
  async wire(tx: Tx, id: string): Promise<Requisition> {
    const [r] = await tx.select().from(requisitions).where(eq(requisitions.id, id));
    if (!r) throw new Error(`requisition ${id} disappeared inside its own transaction`);
    const lines = await tx.select().from(requisitionLines)
      .where(eq(requisitionLines.requisitionId, id)).orderBy(asc(requisitionLines.lineNo));
    const hist = await readHistory(tx, "requisition", id);
    const who = [r.byUser, ...(r.approvedBy ? [r.approvedBy] : [])];
    const names = new Map((await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, who))).map((u) => [u.id, u.name]));
    return strip({
      id: r.id, by: names.get(r.byUser) ?? r.byUser, at: iso(r.at),
      lines: lines.map((l) => strip({ it: l.itemKey, qty: l.qty, appr: l.approvedQty, ordered: l.orderedQty, short: l.shortQty ?? undefined })),
      st: r.status, note: r.note,
      apprBy: r.approvedBy ? names.get(r.approvedBy) ?? r.approvedBy : undefined,
      apprNote: r.approvalNote ?? undefined, hist,
    });
  },
};
