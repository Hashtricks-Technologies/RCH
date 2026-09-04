import type { TicketStatus } from "@rch/contract";
import type { TransitionTable } from "./transitions.js";

/**
 * Customer care for the portal, as five words. Spec §5.1: one table, two consumers — the server
 * refuses anything not listed and the drawer reads the same table to decide which button to draw.
 *
 * There is no support agent in this application (§8.3 has five roles and none of them answers
 * tickets), so every edge here is one a *user* can take, plus the two the seeded desk's replies
 * arrive on. `Open -> With support` is what a first reply from the desk does; the app itself
 * only ever walks the user's edges.
 */
export const SUPPORT_TRANSITIONS: TransitionTable<TicketStatus> = {
  Open: ["With support", "Waiting on you", "Resolved", "Closed"],
  "With support": ["Waiting on you", "Resolved", "Closed"],
  "Waiting on you": ["With support", "Resolved", "Closed"],
  // Reopening is the whole point of showing a rating box: the fix did not land, say so.
  Resolved: ["With support", "Closed"],
  // Closed is the end. A new problem is a new ticket, which is also how the desk counts them.
  Closed: [],
};

/** Spec §9.2, `setTicketStatus`: "user may set Resolved/Closed only". The other three are the
 *  desk's words about its own queue, not the reporter's. */
export const mayUserSet = (st: TicketStatus): boolean => st === "Resolved" || st === "Closed";

/** Spec §9.2, `replyToTicket`: "status Waiting on you / Resolved -> With support". A reply to a
 *  ticket that is already with support, or still Open, says something without moving anything. */
export const statusAfterReply = (st: TicketStatus): TicketStatus =>
  st === "Waiting on you" || st === "Resolved" ? "With support" : st;

/** Spec §9.2, `rateTicket`: "1-5; ticket Resolved or Closed". Rating an open ticket rates a
 *  guess at how it will go. */
export const mayRate = (st: TicketStatus): boolean => st === "Resolved" || st === "Closed";

/** Whether a reply may still be added. Not an edge in the table above: a reply is refused
 *  *before* a message is written, so `statusAfterReply` is never asked about a closed ticket
 *  and the table never sees the case. One rule, two consumers — the service refuses on it and
 *  the drawer hides its reply box on it, so a box the server would refuse is never drawn. */
export const mayReply = (st: TicketStatus): boolean => st !== "Closed";
