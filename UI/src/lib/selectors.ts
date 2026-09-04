import * as D from "@rch/domain";
import { apportion, round3 } from "@rch/domain";
export { apportion, round3 };
import { IT, LOC, MENU, PAR_FACTOR, PL, RCP } from "../data/master";
import type {
  Availability, Bill, LocKey, PoStatus, Price, PurchaseOrder, Requisition, ReqStatus,
  StockRequest, Ticket, Tone,
} from "../types";
import { U } from "./fmt";

export interface StockShape {
  stock: Record<LocKey, Record<string, number>>;
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

export const poValue = (o: PurchaseOrder) =>
  o.lines.reduce((t, l) => t + l.qty * l.rate, 0);

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
export const stateTone = (a: number, rl: number): Tone => (a <= 0 ? "cr" : rl > 0 && a < rl ? "wn" : "ok");
export const stateLabel = (a: number, rl: number) => (a <= 0 ? "Out" : rl > 0 && a < rl ? "Low" : "Healthy");
export const basePrices = () => ({ A: { ...PL.A }, B: { ...PL.B } });
export const isReqOpen = (st: ReqStatus) => st === "Draft" || st === "Request sent";
