import * as D from "@rch/domain";
import { apportion, round3 } from "@rch/domain";
export { apportion, round3 };
// A rule's own tuning rather than master data, so it comes from the domain package and not from
// the registries `hydrateMaster` fills (M11).
import { PAR_FACTOR } from "@rch/domain";
import { IT, LOC, MENU, PL, RCP } from "../data/master";
import type {
  Availability, Bill, LocKey, PoStatus, PordStatus, Price, PurchaseOrder, Requisition, ReqStatus,
  StockLoc, StockRequest, Ticket, TktStatus, Tone,
} from "../types";
import { U } from "./fmt";

export interface StockShape {
  /** Quarantine included — the store keeper's screen reports the rejected-goods shelf. Every
   *  reader below still takes a `LocKey`: stock is shown there, never moved from there. */
  stock: Record<StockLoc, Record<string, number>>;
  rsv: Record<string, number>;
  ovr: Record<string, string>;
  prices: Record<"A" | "B", Record<string, number>>;
  menu: Record<string, string[]>;
}

/** The master data every domain rule below is parameterised by. */
const MASTER: D.Master = { items: IT, locations: LOC, recipes: RCP };

export const qty = (s: StockShape, l: LocKey, it: string) => D.qty(s.stock, l, it);
export const resv = (s: StockShape, l: LocKey, it: string) => D.resv(s.rsv, l, it);
export const avail = (s: StockShape, l: LocKey, it: string) => D.avail(s.stock, s.rsv, l, it);

export function priceOf(s: StockShape, l: LocKey, it: string): Price {
  return D.priceOf(MASTER, s.prices, l, it);
}

export function availOf(s: StockShape, l: LocKey, it: string): Availability {
  return D.availOf(MASTER, s.stock, s.rsv, s.ovr, l, it);
}

/** Σ(ingredient × its cost) plus the recipe's overhead. 0 when there is no recipe (H1). */
export function recipeCost(it: string): number {
  return D.recipeCost(MASTER, it);
}
/** What a unit of this item actually costs — from its recipe if it has one. */
export const costOf = (it: string) => D.costOf(MASTER, it);

/** Reorder level for this item at this location (M11). */
export const parOf = (l: LocKey, it: string) => {
  const base = IT[it]?.rl ?? 0;
  if (!base) return 0;
  const f = PAR_FACTOR[l] ?? 1;
  return U(it) === "nos" ? Math.round(base * f) : round3(base * f);
};

/** Quantity already promised by an approval that has not yet become a ticket. Every request is
 *  raised against the central store, so there is no location to net it against. */
export const committed = (reqs: StockRequest[], it: string) => D.committed(reqs, it);

/**
 * What may still be promised: on hand, less what tickets have reserved, less
 * what other approvals have already committed (C6).
 */
export const freeToPromise = (
  s: StockShape & { req: StockRequest[] }, l: LocKey, it: string,
) => D.freeToPromise(s.stock, s.rsv, s.req, l, it);

/** Purchase-order statuses that already hold a claim on procurement-list quantity.
 *  createPo() moves a requisition line's `ordered` claim out of the pool the instant
 *  a Draft is created — before it is ever sent to a vendor — so Draft must be counted
 *  here or that claimed quantity is visible nowhere. Named CLAIMED, not LIVE, on
 *  purpose: buyer/Dashboard.tsx and buyer/Vendors.tsx each define their own LIVE
 *  constant meaning "open commitment to a vendor", which correctly excludes Draft —
 *  do not merge this with those. */
const CLAIMED: PoStatus[] = ["Draft", "Ordered", "Partially received"];

export function prqProgress(
  s: { prq: Requisition[]; po: PurchaseOrder[] }, prqId: string,
) {
  const p = s.prq.find((x) => x.id === prqId);
  if (!p) return { appr: 0, ordered: 0, received: 0, label: "Unknown" };

  const appr = round3(p.lines.reduce((t, l) => t + l.appr, 0));
  const ordered = round3(p.lines.reduce((t, l) => t + l.ordered, 0));
  const received = round3(s.po
    .filter((o) => o.st !== "Cancelled")
    .reduce((t, o) => t + o.lines.reduce((n, l) => {
      const got = apportion(l.recv, l.src);
      return n + l.src.reduce((m, x, i) => m + (x.prq === prqId ? got[i] : 0), 0);
    }, 0), 0));

  // >= rather than === throughout: intentional float-safety, not a typo —
  // received/ordered can round to a hair over appr and must still count as done.
  const label =
    p.st === "Sent" ? "Awaiting approval"
      : p.st === "Declined" ? "Declined"
        : appr > 0 && received >= appr ? "Received"
          : received > 0 ? "Partly received"
            : appr > 0 && ordered >= appr ? "Ordered"
              : ordered > 0 ? "Partly ordered"
                : "Awaiting order";
  return { appr, ordered, received, label };
}

/** Approved but not yet on the shelf: what is still pending on the procurement
 *  list, plus the undelivered balance of every live purchase order (M3). */
export const onOrder = (
  s: { prq: Requisition[]; po: PurchaseOrder[] }, it: string,
) => round3(
  procurementList(s).filter((l) => l.it === it).reduce((t, l) => t + l.pending, 0)
  + s.po.filter((o) => CLAIMED.includes(o.st))
    .reduce((t, o) => t + o.lines
      .filter((l) => l.it === it)
      .reduce((n, l) => n + Math.max(0, l.qty - l.recv), 0), 0),
);

/** The other half of the M3 duplicate-order guard: quantity asked on a
 *  requisition still awaiting a procurement decision (status "Sent").
 *  onOrder() deliberately excludes this — it reports only what has actually
 *  been approved, which is exactly the narrower meaning prqProgress() and
 *  the stock ledger need. But a requisition that has not even been decided
 *  on yet is the highest-risk window for a duplicate ask (nothing has been
 *  approved, trimmed or declined), so anything guarding against a duplicate
 *  raise must add this in alongside onOrder(). */
export const awaitingApproval = (
  s: { prq: Requisition[] }, it: string,
) => round3(
  s.prq
    .filter((p) => p.st === "Sent")
    .reduce((t, p) => t + p.lines.filter((l) => l.it === it).reduce((n, l) => n + l.qty, 0), 0),
);

export interface PoolLine {
  prq: string; line: number; it: string;
  asked: number; pending: number; by: string; at: string;
}

/** Approved requisition lines not yet claimed by a purchase order. Derived —
 *  there is no stored "procurement list" to keep in sync. */
export const procurementList = (s: { prq: Requisition[] }): PoolLine[] =>
  s.prq
    .filter((p) => p.st === "Approved" || p.st === "Partially approved")
    .flatMap((p) => p.lines.flatMap((l, i) => {
      const pending = round3(l.appr - l.ordered);
      return pending > 0
        ? [{ prq: p.id, line: i, it: l.it, asked: l.qty, pending, by: p.by, at: p.at }]
        : [];
    }));

/** The order's value is `@rch/domain`'s arithmetic, not a second copy of it: the server stamps
 *  `needsApproval` from the same function, and two implementations of one number is exactly the
 *  §5.1 defect Phase 5 exists to remove. Kept as a one-line delegate because three screens and
 *  `procurement.test.ts` already import it from here. */
export const poValue = (o: PurchaseOrder) => D.poValue(o.lines);

/** Handed over but not yet confirmed — owned by neither location (M8). */
export const inTransit = (s: { tkt: Ticket[] }, it: string) =>
  s.tkt
    .filter((t) => t.st === "Collected")
    .reduce((n, t) => n + t.lines.filter((l) => l.it === it).reduce((q, l) => q + l.qty, 0), 0);

/** Only cash reaches the drawer; everything else settles elsewhere (H4). */
export const isCashTender = (pay: string) => pay === "Cash";
export const cashCollected = (bills: Pick<Bill, "pay" | "tot">[]) =>
  bills.filter((b) => isCashTender(b.pay)).reduce((t, b) => t + b.tot, 0);

export const stockValue = (s: StockShape, l: LocKey) =>
  Object.keys(s.stock[l] ?? {}).reduce((t, it) => t + qty(s, l, it) * costOf(it), 0);
export const daysCover = (a: number, it: string, l: LocKey = "store") =>
  a / Math.max(0.001, parOf(l, it) / 4);
export const menuOf = (s: StockShape, l: LocKey) => s.menu[l] ?? MENU[l] ?? [];

const TONES: Record<string, Tone> = {
  Draft: "mu", "Request sent": "wn", "Manager approved": "in", "Partially approved": "wn",
  "Ticket issued": "ac", Collected: "wn", Received: "ok", Closed: "mu", Rejected: "cr", Cancelled: "mu",
  Sent: "wn", Ordered: "in", New: "wn", Accepted: "in", "In kitchen": "ac", Ready: "ok",
  Dispatched: "mu", Declined: "cr", Issued: "ac", Approved: "in", "Partially received": "wn",
  "Awaiting approval": "wn", "Awaiting order": "wn", "Partly ordered": "wn", "Partly received": "wn",
};
export const toneFor = (st: string): Tone => TONES[st] ?? "mu";
/**
 * The dot beside one entry on a **ticket's** trail. Written once because three drawers render
 * that trail and a fourth copy of the same three-way rule is how they drift apart. It is a
 * separate rule from the `dotFor` helpers that colour a *request*'s or a *requisition*'s trail:
 * those read a different vocabulary ("Manager approved", "Ticket issued"), and one name over two
 * vocabularies would invite merging them.
 */
export const ticketDot = (state: string): string =>
  state.startsWith("Cancelled") ? "var(--crit)"
    : state === "Received" ? "var(--good)" : "var(--accent)";
export const stateTone = (a: number, rl: number): Tone => (a <= 0 ? "cr" : rl > 0 && a < rl ? "wn" : "ok");
export const stateLabel = (a: number, rl: number) => (a <= 0 ? "Out" : rl > 0 && a < rl ? "Low" : "Healthy");
export const basePrices = () => ({ A: { ...PL.A }, B: { ...PL.B } });

/**
 * What a button may offer is what the server accepts. Each of these reads the shared
 * transition table in `packages/domain` rather than repeating the status graph here, so a
 * control the UI renders is a transition `assertTransition` on the server will let through.
 */
export const isReqOpen = (st: ReqStatus) => D.canTransition(D.REQUEST_TRANSITIONS, st, "Cancelled");
export const canIssueTicket = (st: ReqStatus) => D.canTransition(D.REQUEST_TRANSITIONS, st, "Ticket issued");
export const canHandOver = (st: TktStatus) => D.canTransition(D.TICKET_TRANSITIONS, st, "Collected");
export const canReceiveTicket = (st: TktStatus) => D.canTransition(D.TICKET_TRANSITIONS, st, "Received");
export const canDispatch = (st: PordStatus) => D.canTransition(D.PROD_ORDER_TRANSITIONS, st, "Dispatched");

/**
 * Whether the board may move an order from one word to another — the same table the server
 * refuses through, so a button the kitchen can see is a press the server will take.
 *
 * The two guards either side of the table are `setStatus`'s own, in the same order it applies
 * them. `Dispatched` is refused as a *destination* because a dispatch is a movement, not a
 * word: it mints the ticket the outlet collects against, so it has its own endpoint and
 * `canDispatch` is the predicate that draws its button. And `Dispatched` is refused as a
 * *source* even though the table has `Dispatched -> Ready`: that edge exists so cancelling the
 * ticket a dispatch raised can put the order back, and it is not a button either.
 */
export const canMoveOrder = (st: PordStatus, to: PordStatus) =>
  to !== "Dispatched" && st !== "Dispatched" && D.canTransition(D.PROD_ORDER_TRANSITIONS, st, to);

/** Whether a ticket can still be withdrawn: only one nobody has collected against. */
export const canCancelTicket = (st: TktStatus) => D.canTransition(D.TICKET_TRANSITIONS, st, "Cancelled");

/** Whether a draft may still go out to its vendor — one table, two consumers (spec §5.1). */
export const canSendPo = (st: PoStatus) => D.canTransition(D.PO_TRANSITIONS, st, "Ordered");
/**
 * Whether an order may still be cancelled. `Ordered -> Cancelled` is a real edge in the table,
 * but the endpoint refuses it outright once anything has arrived — with its own sentence telling
 * the buyer to close it short — so the button has to ask both questions, in that order.
 */
export const canCancelPo = (st: PoStatus, anyReceived: boolean) =>
  !anyReceived && D.canTransition(D.PO_TRANSITIONS, st, "Cancelled");
/** Closing short is not a transition to a new word — it is the only door out of a part-delivered
 *  order, and it takes the order to `Received` with the balance handed back. */
export const canCloseShort = (st: PoStatus) => st === "Partially received";

/**
 * Whether a ticket is still on its way — the measure every "still open" count and every "where
 * is it" sentence reads. Derived from the table rather than written as `!== "Received"`: a
 * cancelled ticket has nowhere left to go either, and counting it as moving put stock on a
 * shelf it never reached.
 */
export const isTicketOpen = (st: TktStatus) => canHandOver(st) || canReceiveTicket(st);

/**
 * Whether the stock on a ticket has actually left the location that raised it — the measure
 * the store's ledger counts an issue by. Read from the table rather than written as
 * `!== "Issued"`: a ticket that can still be handed over has moved nothing, and a withdrawn
 * one never will, so counting one put stock off the shelf that is still standing on it and
 * overstated both the opening balance and what went out.
 */
export const hasLeft = (st: TktStatus) => st !== "Cancelled" && !canHandOver(st);
