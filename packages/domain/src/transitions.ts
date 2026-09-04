import type { PoStatus, PordStatus, PrqStatus, ReqStatus, ShopAskStatus, TktStatus } from "@rch/contract";

/**
 * Spec §5.1: "Status transitions are data, shared by both sides." One table, two consumers —
 * the server refuses anything not listed, and the frontend reads the same table to decide
 * which buttons to render. A transition the UI offers but the server refuses is impossible
 * by construction.
 */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export const REQUEST_TRANSITIONS: TransitionTable<ReqStatus> = {
  Draft: ["Request sent", "Cancelled"],
  "Request sent": ["Manager approved", "Partially approved", "Rejected", "Cancelled"],
  "Manager approved": ["Ticket issued"],
  "Partially approved": ["Ticket issued"],
  "Ticket issued": ["Collected"],
  Collected: ["Closed"],
  // No path puts a request in Received today — the ticket carries that word, the request goes
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
  // then a movement of its own — not an undo.
  Issued: ["Collected", "Cancelled"],
  Collected: ["Received"],
  Received: [],
  Cancelled: [],
};

/**
 * The kitchen's board. `Dispatched` is reachable from every open stage on purpose: the kitchen
 * sends an order out the moment it is ready to, whatever word the board is showing — the
 * store's own `dispatchOrder` refuses only an order already gone or turned down. The rest is
 * spec §9.2's `setOrderStatus` walk, written down now so Phase 4's status endpoint and the
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
 *  orders that claim against it — `ordered_qty` moves, the status does not. */
export const REQUISITION_TRANSITIONS: TransitionTable<PrqStatus> = {
  Sent: ["Approved", "Partially approved", "Declined"],
  Approved: [],
  "Partially approved": [],
  Declined: [],
};

/**
 * A purchase order's life. Two rows read oddly and are deliberate:
 *
 * `Partially received -> Partially received` is a real edge — a second instalment that still
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

export const canTransition = <S extends string>(table: TransitionTable<S>, from: S, to: S): boolean =>
  (table[from] ?? []).includes(to);
