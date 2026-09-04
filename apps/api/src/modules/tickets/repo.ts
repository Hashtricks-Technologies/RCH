// Tickets: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PordStatus, ReqStatus, ShopAskStatus, TktStatus } from "@rch/contract";
import type { Tx } from "../../lib/db.js";
import type { TicketRefType } from "../../lib/tickets.js";
import { prodOrders, shopAsks, stockBalances, stockRequestLines, stockRequests, ticketLines, tickets, users } from "../../db/schema/index.js";

/** What a ticket carries in `ref_id` when there is no document behind it to close. */
const NO_DOCUMENT: readonly string[] = ["Shop transfer", "Direct issue"];

/** The head row under its lock, with the lines every caller needs in the same breath. */
type LockedTicket = {
  id: string; req: string; refType: TicketRefType; from: string; to: string; st: TktStatus; otp: string;
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
   *
   * `refType` is what a cancellation reads to know which document is behind the ticket:
   * `linkedRequest` answers `undefined` both for a ticket that has none and for a `PRD-` id
   * that was never a request, and the two take different branches. `handover` and `receive`
   * have no use for it.
   */
  async head(tx: Tx, id: string): Promise<LockedTicket | undefined> {
    const [t] = await tx.select({
      id: tickets.id, req: tickets.refId, refType: tickets.refType, from: tickets.fromLoc, to: tickets.toLoc, st: tickets.status, otp: tickets.otp,
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

  /** The decided lines of the request behind a ticket, for `approvedStatus`. */
  async requestLines(tx: Tx, id: string): Promise<{ qty: number; appr: number }[]> {
    const rows = await tx.select({ qty: stockRequestLines.qty, appr: stockRequestLines.approvedQty })
      .from(stockRequestLines).where(eq(stockRequestLines.requestId, id)).orderBy(asc(stockRequestLines.lineNo));
    return rows;
  },

  /** Back to an approved status with no ticket against it, so the issue desk can raise another.
   *  Separate from `setRequestStatus` because clearing `ticket_id` is exactly what makes this
   *  different from every other status write on a request. */
  async releaseRequest(tx: Tx, id: string, status: ReqStatus): Promise<void> {
    await tx.update(stockRequests).set({ status, ticketId: null, updatedAt: new Date() }).where(eq(stockRequests.id, id));
  },

  /** The production order behind a dispatch ticket, locked like every other document a write
   *  moves. Only called when the ticket's ref_type says there is one. */
  async linkedProdOrder(tx: Tx, id: string): Promise<{ id: string; status: PordStatus } | undefined> {
    const [o] = await tx.select({ id: prodOrders.id, status: prodOrders.status })
      .from(prodOrders).where(eq(prodOrders.id, id)).for("update");
    return o;
  },

  async setProdOrderStatus(tx: Tx, id: string, status: PordStatus): Promise<void> {
    await tx.update(prodOrders).set({ status, updatedAt: new Date() }).where(eq(prodOrders.id, id));
  },

  /**
   * The ask a shop-ask ticket was raised for, locked like every other document a write moves —
   * and taken *after* the ticket's own `for update` above, documents in one order, always. Only
   * called when the ticket's `ref_type` says there is one; `answer` (`modules/shopasks/service.ts`)
   * writes the ask's own id into `ref_id`.
   *
   * The house rule is that a status transition reads its own row `for update`, and the
   * cancellation does move this ask from `Sent` to `Asked`. What the lock is *not* is the thing
   * that makes two racing cancellations safe: the ticket's row is locked first and one ask can
   * only ever have one live ticket against it, so the pair are already serialised before this
   * row is read. `tickets.test.ts`'s race case pins the outcome and says so.
   */
  async linkedShopAsk(tx: Tx, askId: string): Promise<{ id: string; status: ShopAskStatus } | undefined> {
    const [row] = await tx.select({ id: shopAsks.id, status: shopAsks.status })
      .from(shopAsks).where(eq(shopAsks.id, askId)).for("update");
    return row;
  },

  /** Back to Asked, with the grant and the ticket cleared, so the holding shop can answer again.
   *  Separate from `setAnswer` in the shopasks repo for the same reason `releaseRequest` is
   *  separate from `setRequestStatus`: clearing the two columns is what makes it a reopen. */
  async reopenShopAsk(tx: Tx, askId: string): Promise<void> {
    await tx.update(shopAsks).set({ status: "Asked", grantedQty: null, ticketId: null, updatedAt: new Date() }).where(eq(shopAsks.id, askId));
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
