import type { StockRequest } from "@rch/contract";
import { avail } from "./master.js";
import type { RsvMap, StockMap } from "./master.js";

type ReqShape = Pick<StockRequest, "st" | "ticket" | "lines">;

/** Quantity already promised by an approval that has not yet become a ticket. There is no
 *  location to take: every stock request is raised against the central store, so an approval
 *  only ever commits the store's own shelf. `freeToPromise` still takes one, for the on-hand. */
export const committed = (reqs: ReqShape[], it: string): number =>
  reqs
    .filter((r) => (r.st === "Manager approved" || r.st === "Partially approved") && !r.ticket)
    .reduce((t, r) => t + r.lines.filter((x) => x.it === it).reduce((n, x) => n + x.appr, 0), 0);

/**
 * What may still be promised: on hand, less what tickets have reserved, less
 * what other approvals have already committed (C6).
 */
export const freeToPromise = (stock: StockMap, rsv: RsvMap, reqs: ReqShape[], l: string, it: string): number =>
  avail(stock, rsv, l, it) - committed(reqs, it);
