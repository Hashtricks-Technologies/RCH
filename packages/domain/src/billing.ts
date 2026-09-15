import type { BillLine } from "@rch/contract";
import { priceOf } from "./pricing.js";
import type { Master, Prices } from "./master.js";

export type BillPlan = {
  lines: BillLine[];
  tot: number;
  tax: number;
  moves: { loc: string; it: string; qty: number }[];
};

/**
 * The arithmetic of a sale: price each cart line at the till price, total it,
 * derive GST from the inclusive prices, and take each stocked line off the shelf
 * as a negative stock move. A made-to-order line holds no stock, so it moves
 * nothing. Does not check availability or payer rules - those are `assertRule`s
 * in the service, using `availOf`.
 *
 * The MRP cap needs no separate report: `priceOf` applies it, so the line's own
 * `rate` is what the customer pays. A list price can never sit above the MRP in
 * the first place - `savePrice` refuses one - so the cap only ever bites when an
 * MRP is lowered after the item was priced, and the till simply charges the new
 * printed number.
 */
export function planBill(m: Master, prices: Prices, l: string, cart: Record<string, number>): BillPlan {
  let tot = 0;
  let tax = 0;
  const lines: BillLine[] = [];
  const moves: { loc: string; it: string; qty: number }[] = [];
  for (const it of Object.keys(cart)) {
    const n = cart[it];
    const price = priceOf(m, prices, l, it);
    const amt = price.p * n;
    tot += amt;
    const gst = m.items[it]?.gst ?? 0;
    tax += amt - amt / (1 + gst / 100);
    if (m.items[it]?.t !== "MTO") moves.push({ loc: l, it, qty: -n });
    lines.push({ it, qty: n, rate: price.p });
  }
  return { lines, tot, tax, moves };
}
