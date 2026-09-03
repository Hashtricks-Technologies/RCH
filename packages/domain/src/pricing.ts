import type { Price } from "@rch/contract";
import type { Master, Prices } from "./master.js";

/** What a location charges for an item on its current price list, capped at the
 *  printed MRP for a traded item — the cap is applied at read time, never stored. */
export function priceOf(m: Master, prices: Prices, l: string, it: string): Price {
  const list = m.locations[l]?.list;
  if (!list) return { p: 0, listed: 0, capped: false };
  const listed = prices[list]?.[it];
  if (listed == null) return { p: 0, listed: 0, capped: false };
  const mrp = m.items[it]?.mrp;
  return mrp != null && listed > mrp
    ? { p: mrp, listed, capped: true }
    : { p: listed, listed, capped: false };
}
