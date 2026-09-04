// Requests: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { LocKey, ReqStatus, StockRequest } from "@rch/contract";
import type { Tx } from "../../lib/db.js";
import { readHistory } from "../../lib/history.js";
import { iso } from "../../lib/time.js";
import { stockBalances, stockRequestLines, stockRequests, users } from "../../db/schema/index.js";

export type RequestRow = typeof stockRequests.$inferSelect;
export type NewRequest = typeof stockRequests.$inferInsert;
/** One line as every rule in this module reads it: what was asked, and what stands approved. */
export type RequestLine = { it: string; qty: number; appr: number };
/** What a decision writes back onto a line. */
export type ApprovedLine = { it: string; appr: number; short: number };
export type StatusPatch = { status?: ReqStatus; managerNote?: string; approvedBy?: string; ticketId?: string };

/** A nullable column reads back as null; dropping the key keeps the wire shape the snapshot's
 *  reader produces (readers/documents.ts), so a screen cannot tell the two apart. */
const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export const requestsRepo = {
  /**
   * The head, read **for update**. Every transition guard in this module reads through here, so
   * the row is held to the end of the transaction: two store keepers pressing Issue together
   * queue on this line, and the second reads the status the first committed instead of the one
   * they both started from.
   */
  async head(tx: Tx, id: string): Promise<RequestRow | undefined> {
    const [r] = await tx.select().from(stockRequests).where(eq(stockRequests.id, id)).for("update");
    return r;
  },

  async lines(tx: Tx, id: string): Promise<RequestLine[]> {
    const rows = await tx.select().from(stockRequestLines)
      .where(eq(stockRequestLines.requestId, id)).orderBy(asc(stockRequestLines.lineNo));
    return rows.map((l) => ({ it: l.itemKey, qty: l.qty, appr: l.approvedQty }));
  },

  async insertRequest(tx: Tx, row: NewRequest): Promise<void> {
    await tx.insert(stockRequests).values(row);
  },

  /** Line numbers are the order the counter typed them, and every reader sorts on them. */
  async insertLines(tx: Tx, id: string, lines: readonly { it: string; qty: number }[]): Promise<void> {
    if (lines.length === 0) return;
    await tx.insert(stockRequestLines).values(lines.map((l, lineNo) => ({ requestId: id, lineNo, itemKey: l.it, qty: l.qty })));
  },

  async setStatus(tx: Tx, id: string, patch: StatusPatch): Promise<void> {
    await tx.update(stockRequests).set({ ...patch, updatedAt: new Date() }).where(eq(stockRequests.id, id));
  },

  /** The decision, line by line, in the order `lines()` handed them out. */
  async setLineApprovals(tx: Tx, id: string, lines: readonly ApprovedLine[]): Promise<void> {
    for (const [lineNo, l] of lines.entries()) {
      await tx.update(stockRequestLines).set({ approvedQty: l.appr, shortQty: l.short })
        .where(and(eq(stockRequestLines.requestId, id), eq(stockRequestLines.lineNo, lineNo)));
    }
  },

  /** Every approval that has not yet become a ticket — exactly what `committed()` nets off.
   *  Shaped for the domain function, so nothing here knows what it will be used for. */
  async openRequests(tx: Tx): Promise<Pick<StockRequest, "st" | "ticket" | "lines">[]> {
    const heads = await tx.select().from(stockRequests).where(inArray(stockRequests.status, ["Manager approved", "Partially approved"]));
    const open = heads.filter((h) => h.ticketId === null);
    if (open.length === 0) return [];
    const lines = await tx.select().from(stockRequestLines).where(inArray(stockRequestLines.requestId, open.map((h) => h.id)));
    return open.map((h) => ({
      st: h.status, ticket: h.ticketId,
      lines: lines.filter((l) => l.requestId === h.id).map((l) => ({ it: l.itemKey, qty: l.qty, appr: l.approvedQty })),
    }));
  },

  /** On hand at one location for the items a decision is about. A cell with no row is absent,
   *  which the caller reads as zero — the same thing the stock screens show as a dash. */
  async balancesAt(tx: Tx, loc: string, itemKeys: readonly string[]): Promise<Record<string, number>> {
    if (itemKeys.length === 0) return {};
    const rows = await tx.select().from(stockBalances)
      .where(and(eq(stockBalances.loc, loc), inArray(stockBalances.itemKey, [...itemKeys])));
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.onHand]));
  },

  /** History is signed with a name, not an id: it is read on a screen. */
  async userName(tx: Tx, id: string): Promise<string> {
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },

  /** One request in the shape the snapshot hands out, for a service that has just changed it. */
  async wire(tx: Tx, id: string): Promise<StockRequest> {
    const [r] = await tx.select().from(stockRequests).where(eq(stockRequests.id, id));
    if (!r) throw new Error(`request ${id} disappeared inside its own transaction`);
    const lines = await tx.select().from(stockRequestLines)
      .where(eq(stockRequestLines.requestId, id)).orderBy(asc(stockRequestLines.lineNo));
    const hist = await readHistory(tx, "request", id);
    const who = [r.byUser, ...(r.approvedBy ? [r.approvedBy] : [])];
    const names = new Map((await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, who))).map((u) => [u.id, u.name]));
    return strip({
      id: r.id, from: r.fromLoc as LocKey, by: names.get(r.byUser) ?? r.byUser, at: iso(r.at),
      lines: lines.map((l) => strip({ it: l.itemKey, qty: l.qty, appr: l.approvedQty, short: l.shortQty ?? undefined })),
      st: r.status, ticket: r.ticketId, mgrNote: r.managerNote, urg: r.urgent || undefined, hist,
      apprBy: r.approvedBy ? names.get(r.approvedBy) ?? r.approvedBy : undefined,
    });
  },
};
