import type { BillLine } from "@rch/contract";
import { discountOn } from "./discount.js";
import { priceOf } from "./pricing.js";
import type { Master, Prices } from "./master.js";

export type BillPlan = {
  lines: BillLine[];
  /** What the bill is worth and what is owed: the gross less the discount. Every figure that
   *  counts money - a day's takings, a credit balance, a void's reversal - reads this one. */
  tot: number;
  /** What the party's rate took off on the way there. `tot + disc` is the gross, which is why
   *  the gross is not stored anywhere: it is two numbers added. */
  disc: number;
  tax: number;
  moves: { loc: string; it: string; qty: number }[];
};

/**
 * The arithmetic of a sale: price each cart line at the till price, take the party's discount
 * off the total, derive GST from what is actually being charged, and take each stocked line off
 * the shelf as a negative stock move. A made-to-order line holds no stock, so it moves nothing.
 * Does not check availability or payer rules - those are `assertRule`s in the service, using
 * `availOf` - and does not decide the rate, which is the rate card's job.
 *
 * The MRP cap needs no separate report: `priceOf` applies it, so the line's own `rate` is the
 * printed price the customer is being charged before any concession. A list price can never sit
 * above the MRP in the first place - `savePrice` refuses one - so the cap only ever bites when
 * an MRP is lowered after the item was priced, and the till simply charges the new printed number.
 *
 * The discount is taken off the **line**, not off the bill total, and the tax is derived from
 * what is left. Doing it the other way round would put the whole concession on one GST slab and
 * make the tax split on a mixed cart wrong by a few paise every time - a slip file, not a
 * rounding artefact. `rate` on the line stays the printed price: a bill has to show what the
 * product costs as well as what this person paid for it.
 */
export function planBill(m: Master, prices: Prices, l: string, cart: Record<string, number>, pct = 0): BillPlan {
  let tot = 0;
  let disc = 0;
  let tax = 0;
  const lines: BillLine[] = [];
  const moves: { loc: string; it: string; qty: number }[] = [];
  for (const it of Object.keys(cart)) {
    const n = cart[it];
    const price = priceOf(m, prices, l, it);
    const gross = price.p * n;
    const off = discountOn(gross, pct);
    const amt = gross - off;
    tot += amt;
    disc += off;
    const gst = m.items[it]?.gst ?? 0;
    tax += amt - amt / (1 + gst / 100);
    if (m.items[it]?.t !== "MTO") moves.push({ loc: l, it, qty: -n });
    lines.push({ it, qty: n, rate: price.p });
  }
  return { lines, tot, disc, tax, moves };
}
