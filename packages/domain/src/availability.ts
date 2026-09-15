import type { Availability } from "@rch/contract";
import { avail } from "./master.js";
import type { Master, OvrMap, RsvMap, StockMap } from "./master.js";

const unitOf = (m: Master, it: string): string => m.items[it]?.u ?? "nos";

/** Countable units are whole on the shelf but may be fractional on a document; other
 *  units always show three decimals - the same wording the UI has always used.
 *  Exported so a server refusal ("Only 9 nos … left") speaks with the shelf's voice. */
export const fq = (v: number, unit: string): string => {
  const n = v || 0;
  if (unit === "nos") return Number.isInteger(n) ? String(n) : n.toFixed(3);
  return n.toFixed(3);
};

/**
 * Whether an item can be sold at a location right now: a manual override wins
 * outright; a made-to-order item holds no stock, so the switch is the only thing
 * that turns it off; a stocked item is off at zero.
 */
export function availOf(m: Master, stock: StockMap, rsv: RsvMap, ovr: OvrMap, l: string, it: string): Availability {
  const o = ovr[`${l}:${it}`];
  if (o) return { ok: false, mode: "Manual", why: o };
  if (m.items[it]?.t === "MTO") return { ok: true, mode: "Manual" };
  const have = avail(stock, rsv, l, it);
  return have >= 1
    ? { ok: true, mode: "Stock", left: `${fq(have, unitOf(m, it))} ${unitOf(m, it)}` }
    : { ok: false, mode: "Stock", why: "zero at this location" };
}
