// Tickets: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { ReqStatus, TktStatus } from "@rch/contract";
import type { Tx } from "../../lib/db.js";
import { stockBalances, stockRequests, ticketLines, tickets, users } from "../../db/schema/index.js";

/** What a ticket carries in `ref_id` when there is no document behind it to close. */
const NO_DOCUMENT: readonly string[] = ["Shop transfer", "Direct issue"];

/** The head row under its lock, with the lines every caller needs in the same breath. */
type LockedTicket = {
  id: string; req: string; from: string; to: string; st: TktStatus; otp: string;
  lines: { it: string; qty: number }[];
};

export const ticketsRepo = {
  /**
   * The transition guard's lock, not merely its read. Two windows pressing "Hand over" on one
   * ticket both see `Issued` without the `for update`, both pass `assertTransition` and both
   * post `ticket_out` — the stock leaves twice. The lock is held to the end of the
   * transaction, so the second caller reads the status the first committed and is refused.
   *
   * The lines come along unlocked on purpose: they are written once when the ticket is issued
   * and never change, so there is nothing for a second writer to move under us.
   */
  async head(tx: Tx, id: string): Promise<LockedTicket | undefined> {
    const [t] = await tx.select({
      id: tickets.id, req: tickets.refId, from: tickets.fromLoc, to: tickets.toLoc, st: tickets.status, otp: tickets.otp,
    }).from(tickets).where(eq(tickets.id, id)).for("update");
    if (!t) return undefined;
    const lines = await tx.select().from(ticketLines).where(eq(ticketLines.ticketId, id)).orderBy(asc(ticketLines.lineNo));
    return { ...t, lines: lines.map((l) => ({ it: l.itemKey, qty: l.qty })) };
  },

  /** The lifecycle is three timestamps on the row (spec §16), so the status never travels alone. */
  async setStatus(tx: Tx, id: string, patch: { status: TktStatus; collectedAt?: Date; receivedAt?: Date }): Promise<void> {
    await tx.update(tickets).set(patch).where(eq(tickets.id, id));
  },

  /**
   * The request the ticket was raised against, locked the same way and for the same reason —
   * the scan moves it on too. A shop transfer and a direct issue name a label rather than a
   * document, and a kitchen dispatch names a production order: none of them is a request, and
   * none of them has a row here.
   */
  async linkedRequest(tx: Tx, refId: string): Promise<{ id: string; status: ReqStatus } | undefined> {
    if (NO_DOCUMENT.includes(refId)) return undefined;
    const [r] = await tx.select({ id: stockRequests.id, status: stockRequests.status })
      .from(stockRequests).where(eq(stockRequests.id, refId)).for("update");
    return r;
  },

  async setRequestStatus(tx: Tx, id: string, status: ReqStatus): Promise<void> {
    await tx.update(stockRequests).set({ status, updatedAt: new Date() }).where(eq(stockRequests.id, id));
  },

  /** Read back after `postMoves` has taken the locks — the only number a movement may trust. */
  async balancesAt(tx: Tx, loc: string, itemKeys: readonly string[]): Promise<Record<string, number>> {
    if (itemKeys.length === 0) return {};
    const rows = await tx.select().from(stockBalances)
      .where(and(eq(stockBalances.loc, loc), inArray(stockBalances.itemKey, [...itemKeys])));
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.onHand]));
  },

  /** History is signed with the name the operator reads on the document, not with an id. */
  async userName(tx: Tx, id: string): Promise<string> {
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },
};
