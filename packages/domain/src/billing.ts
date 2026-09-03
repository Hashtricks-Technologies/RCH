import type { BillLine } from "@rch/contract";
import { round3 } from "./round.js";
import { priceOf } from "./pricing.js";
import type { Master, Prices } from "./master.js";

export type BillPlan = {
  lines: BillLine[];
  tot: number;
  tax: number;
  moves: { loc: string; it: string; qty: number }[];
  capped: string[];
};

/**
 * The arithmetic of a sale: price each cart line at the till price, total it,
 * derive GST from the inclusive prices, and explode a made-to-order line into
 * negative stock moves for its recipe. Does not check availability or payer
 * rules — those are `assertRule`s in the service, using `availOf`.
 */
export function planBill(m: Master, prices: Prices, l: string, cart: Record<string, number>): BillPlan {
  let tot = 0;
  let tax = 0;
  const lines: BillLine[] = [];
  const moves: { loc: string; it: string; qty: number }[] = [];
  const capped: string[] = [];
  for (const it of Object.keys(cart)) {
    const n = cart[it];
    const price = priceOf(m, prices, l, it);
    if (price.capped) capped.push(it);
    const amt = price.p * n;
    tot += amt;
    const gst = m.items[it]?.gst ?? 0;
    tax += amt - amt / (1 + gst / 100);
    if (m.items[it]?.t === "MTO") {
      const r = m.recipes[it];
      for (const [g, need] of r.l) moves.push({ loc: l, it: g, qty: -round3(need * n) });
    } else {
      moves.push({ loc: l, it, qty: -n });
    }
    lines.push({ it, qty: n, rate: price.p });
  }
  return { lines, tot, tax, moves, capped };
}
