// Adjustment requests: SQL only. No rules, no transaction of its own - service.ts passes `tx` in.
import { asc, eq, inArray } from "drizzle-orm";
import type { AdjReqStatus, AdjustmentRequest, LocKey } from "@rch/contract";
import { adjustmentRequestLines, adjustmentRequests, users } from "../../db/schema/index.js";
import type { Tx } from "../../lib/db.js";
import { readHistory } from "../../lib/history.js";
import { iso } from "../../lib/time.js";

export type RequestRow = typeof adjustmentRequests.$inferSelect;
export type NewRequest = typeof adjustmentRequests.$inferInsert;
export type StatusPatch = { status?: AdjReqStatus; approvedBy?: string; adjustmentId?: string };

/** A nullable column reads back as null; dropping the key keeps the wire shape the snapshot's
 *  reader produces (readers/documents.ts), so a screen cannot tell the two apart. */
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const adjustmentRequestsRepo = {
  /** The head, read **for update**. Every transition guard in this module reads through here,
   *  so the row is held to the end of the transaction: two managers pressing Approve together
   *  queue on this line, and the second reads the status the first committed. */
  async head(tx: Tx, id: string): Promise<RequestRow | undefined> {
    const [r] = await tx.select().from(adjustmentRequests).where(eq(adjustmentRequests.id, id)).for("update");
    return r;
  },

  async lines(tx: Tx, id: string): Promise<{ it: string; qty: number }[]> {
    const rows = await tx.select().from(adjustmentRequestLines)
      .where(eq(adjustmentRequestLines.requestId, id)).orderBy(asc(adjustmentRequestLines.lineNo));
    return rows.map((l) => ({ it: l.itemKey, qty: l.qty }));
  },

  async insertRequest(tx: Tx, row: NewRequest): Promise<void> {
    await tx.insert(adjustmentRequests).values(row);
  },

  /** Line numbers are the order the counter typed them, and every reader sorts on them. */
  async insertLines(tx: Tx, id: string, lines: readonly { it: string; qty: number }[]): Promise<void> {
    if (lines.length === 0) return;
    await tx.insert(adjustmentRequestLines).values(lines.map((l, lineNo) => ({ requestId: id, lineNo, itemKey: l.it, qty: l.qty })));
  },

  async setStatus(tx: Tx, id: string, patch: StatusPatch): Promise<void> {
    await tx.update(adjustmentRequests).set({ ...patch, updatedAt: new Date() }).where(eq(adjustmentRequests.id, id));
  },

  /** History is signed with a name, not an id: it is read on a screen. */
  async userName(tx: Tx, id: string): Promise<string> {
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },

  /** One request in the shape the snapshot hands out, for a service that has just changed it. */
  async wire(tx: Tx, id: string): Promise<AdjustmentRequest> {
    const [r] = await tx.select().from(adjustmentRequests).where(eq(adjustmentRequests.id, id));
    if (!r) throw new Error(`adjustment request ${id} disappeared inside its own transaction`);
    const lines = await tx.select().from(adjustmentRequestLines)
      .where(eq(adjustmentRequestLines.requestId, id)).orderBy(asc(adjustmentRequestLines.lineNo));
    const hist = await readHistory(tx, "adjustment_request", id);
    const who = [r.byUser, ...(r.approvedBy ? [r.approvedBy] : [])];
    const names = new Map((await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, who))).map((u) => [u.id, u.name]));
    return strip({
      id: r.id, loc: r.loc as LocKey, reason: r.reason, note: r.note,
      by: names.get(r.byUser) ?? r.byUser, at: iso(r.at),
      lines: lines.map((l) => ({ it: l.itemKey, qty: l.qty })),
      st: r.status, hist,
      apprBy: r.approvedBy ? names.get(r.approvedBy) ?? r.approvedBy : undefined,
      adjId: r.adjustmentId ?? undefined,
    });
  },
};
