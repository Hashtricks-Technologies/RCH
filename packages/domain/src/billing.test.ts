import { describe, expect, it } from "vitest";
import { IT, LOC, PL, RCP } from "@rch/contract/fixtures";
import { planBill } from "./billing";
const M = { items: IT, locations: LOC, recipes: RCP };
describe("planBill", () => {
  it("prices each line at the till price, totals, and derives GST from inclusive prices", () => {
    const b = planBill(M, PL, "coffee", { juice: 2, chips: 2, bisc: 1 }); // 20*2 + 20*2 + 30 = 110 (list B)
    expect(b.tot).toBe(110); expect(b.tax).toBeCloseTo(40 - 40 / 1.12 + 40 - 40 / 1.12 + 30 - 30 / 1.18, 6);
    expect(b.lines).toEqual([{ it: "juice", qty: 2, rate: 20 }, { it: "chips", qty: 2, rate: 20 }, { it: "bisc", qty: 1, rate: 30 }]);
    expect(b.moves).toEqual([{ loc: "coffee", it: "juice", qty: -2 }, { loc: "coffee", it: "chips", qty: -2 }, { loc: "coffee", it: "bisc", qty: -1 }]);
  });
  it("explodes a made-to-order line into its recipe, rounded to three decimals", () => {
    const b = planBill(M, PL, "rest", { capp: 2 });
    expect(b.moves).toEqual([{ loc: "rest", it: "milk", qty: -0.3 }, { loc: "rest", it: "beans", qty: -0.024 }, { loc: "rest", it: "sugar", qty: -0.012 }, { loc: "rest", it: "cup", qty: -2 }]);
  });
  it("reports capped items", () => { const b = planBill(M, { A: { ...PL.A, juice: 25 }, B: PL.B }, "rest", { juice: 1 }); expect(b.lines[0].rate).toBe(20); expect(b.capped).toEqual(["juice"]); });
});
