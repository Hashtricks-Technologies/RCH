import type { AdjReqStatus, PoStatus, PordStatus, PrqStatus, QrOrderStatus, RefundStatus, ReqStatus, ShopAskStatus, TktStatus } from "@rch/contract";

/**
 * Status transitions are data, shared by both sides. One table, two consumers -
 * the server refuses anything not listed, and the frontend reads the same table to decide
 * which buttons to render. A transition the UI offers but the server refuses is impossible
 * by construction.
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export const REQUEST_TRANSITIONS: TransitionTable<ReqStatus> = {
  Draft: ["Request sent", "Cancelled"],
  "Request sent": ["Manager approved", "Partially approved", "Rejected", "Cancelled"],
  "Manager approved": ["Ticket issued", "Cancelled"],
  "Partially approved": ["Ticket issued", "Cancelled"],
  "Ticket issued": ["Collected"],
  Collected: ["Closed"],
  // No path puts a request in Received today - the ticket carries that word, the request goes
  // straight from Collected to Closed when the shelf confirms. Kept reachable to Closed so a
  // migrated or hand-corrected row is not stranded.
  Received: ["Closed"],
  Closed: [],
  Rejected: [],
  Cancelled: [],
};

export const TICKET_TRANSITIONS: TransitionTable<TktStatus> = {
  // A ticket that was never collected can be withdrawn, which releases the hold it placed.
  // Once it has been handed over the stock is in transit and the way back is a receipt and
  // then a movement of its own - not an undo.
  Issued: ["Collected", "Cancelled"],
  Collected: ["Received"],
  Received: [],
  Cancelled: [],
};

/**
 * The kitchen's board. `Dispatched` is reachable from every open stage on purpose: the kitchen
 * sends an order out the moment it is ready to, whatever word the board is showing - the
 * store's own `dispatchOrder` refuses only an order already gone or turned down. The rest is
 * the `setOrderStatus` walk, written down now so Phase 4's status endpoint and the
 * board's buttons read one table.
 */
export const PROD_ORDER_TRANSITIONS: TransitionTable<PordStatus> = {
  New: ["Accepted", "Declined", "Dispatched"],
  Accepted: ["In kitchen", "Dispatched"],
  "In kitchen": ["Ready", "Dispatched"],
  Ready: ["Dispatched"],
  // The one way back onto the board, and it is not a button: cancelling the ticket a dispatch
  // raised leaves the order undelivered, and calling it Dispatched would be a lie. The status
  // endpoint refuses `Dispatched` as a source and `canMoveOrder` refuses it as a source too,
  // so nothing but a cancellation can take this edge.
  Dispatched: ["Ready"],
  Declined: [],
};

export const SHOP_ASK_TRANSITIONS: TransitionTable<ShopAskStatus> = {
  Asked: ["Sent", "Declined"],
  // Withdrawing the ticket a grant raised is the one way back. The holding shop granted, changed
  // its mind before anyone collected, and cancelled the ticket; leaving the ask at Sent would
  // show the asking shop stock that is coming and the holding shop a document it has undone.
  Sent: ["Asked"],
  Declined: [],
};

/** A requisition is decided once, and everything after the decision happens on the purchase
 *  orders that claim against it - `ordered_qty` moves, the status does not. */
export const REQUISITION_TRANSITIONS: TransitionTable<PrqStatus> = {
  Sent: ["Approved", "Partially approved", "Declined"],
  Approved: [],
  "Partially approved": [],
  Declined: [],
};

/**
 * A purchase order's life. Two rows read oddly and are deliberate:
 *
 * `Partially received -> Partially received` is a real edge - a second instalment that still
 * does not complete the order re-enters the status it was already in, and the status is computed
 * from the totals rather than from where it started.
 *
 * `Ordered -> Cancelled` is listed, but an order with anything received is refused before the
 * table is ever consulted, with its own sentence telling the buyer to close it short instead.
 * `Partially received` has no `Cancelled` at all: the claim on goods that arrived cannot be
 * given back. An edge reachable through one door is guarded at that door.
 */
export const PO_TRANSITIONS: TransitionTable<PoStatus> = {
  Draft: ["Ordered", "Cancelled"],
  Ordered: ["Partially received", "Received", "Cancelled"],
  "Partially received": ["Partially received", "Received"],
  Received: [],
  Cancelled: [],
};

/** A counter's ask to correct its own shelf. Unlike `REQUEST_TRANSITIONS`, "Approved" is the end
 *  of the line rather than a hand-off to a ticket - there is nothing physical to scan after a
 *  write-off, so approving one is the whole of the movement, not the first half of it. */
export const ADJUSTMENT_REQUEST_TRANSITIONS: TransitionTable<AdjReqStatus> = {
  "Request sent": ["Approved", "Rejected", "Cancelled"],
  Approved: [],
  Rejected: [],
  Cancelled: [],
};

/**
 * A QR order's life. Three rows read oddly and are deliberate:
 *
 * `Expired -> Paid` and `Expired -> Refunded`: an unpaid order expires after its window, but the
 * gateway may still capture a payment the customer started before it did. That late capture is
 * billed if the outlet can still fill it and refunded if it cannot - never lost.
 *
 * `Preparing` goes to either `Ready` or `Out for delivery`. Which one is the code's mode
 * (`nextQrStep`), guarded at the status door; the table only says both follow.
 *
 * `Collected` and `Delivered` go to `Voided`: the manager's same-day void of the bill behind the
 * order takes the order with it, whatever step the counter had reached.
 */
export const QR_ORDER_TRANSITIONS: TransitionTable<QrOrderStatus> = {
  "Awaiting payment": ["Paid", "Refunded", "Expired"],
  Expired: ["Paid", "Refunded"],
  Paid: ["Preparing", "Voided"],
  Preparing: ["Ready", "Out for delivery", "Voided"],
  Ready: ["Collected", "Voided"],
  "Out for delivery": ["Delivered", "Voided"],
  Collected: ["Voided"],
  Delivered: ["Voided"],
  Refunded: [],
  Voided: [],
};

/** A refund's journey through the gateway. A refund the gateway refused (or the worker gave up
 *  on) waits at `Failed` for a manager's retry, which puts it back in the queue. */
export const REFUND_TRANSITIONS: TransitionTable<RefundStatus> = {
  Pending: ["Sent", "Failed"],
  Sent: ["Processed", "Failed"],
  Failed: ["Pending"],
  Processed: [],
};

export const canTransition = <S extends string>(table: TransitionTable<S>, from: S, to: S): boolean =>
  (table[from] ?? []).includes(to);
