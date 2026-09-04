import type { ReqStatus, ShopAskStatus, TktStatus } from "@rch/contract";

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
  Issued: ["Collected"],
  Collected: ["Received"],
  Received: [],
};

export const SHOP_ASK_TRANSITIONS: TransitionTable<ShopAskStatus> = {
  Asked: ["Sent", "Declined"],
  Sent: [],
  Declined: [],
};

export const canTransition = <S extends string>(table: TransitionTable<S>, from: S, to: S): boolean =>
  (table[from] ?? []).includes(to);
