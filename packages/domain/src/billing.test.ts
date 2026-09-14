import { describe, expect, it } from "vitest";
import { IT, LOC, PL } from "@rch/contract/fixtures";
import { planBill } from "./billing";
const M = { items: IT, locations: LOC };
describe("planBill", () => {
  it("prices each line at the till price, totals, and derives GST from inclusive prices", () => {
    const b = planBill(M, PL, "coffee", { juice: 2, chips: 2, bisc: 1 }); // 20*2 + 20*2 + 30 = 110 (list B)
    expect(b.tot).toBe(110); expect(b.tax).toBeCloseTo(40 - 40 / 1.12 + 40 - 40 / 1.12 + 30 - 30 / 1.18, 6);
    expect(b.lines).toEqual([{ it: "juice", qty: 2, rate: 20 }, { it: "chips", qty: 2, rate: 20 }, { it: "bisc", qty: 1, rate: 30 }]);
    expect(b.moves).toEqual([{ loc: "coffee", it: "juice", qty: -2 }, { loc: "coffee", it: "chips", qty: -2 }, { loc: "coffee", it: "bisc", qty: -1 }]);
  });
  it("bills a made-to-order line without moving any stock", () => {
    const b = planBill(M, PL, "rest", { capp: 2, juice: 1 });
    expect(b.lines).toEqual([{ it: "capp", qty: 2, rate: 60 }, { it: "juice", qty: 1, rate: 18 }]);
    expect(b.moves).toEqual([{ loc: "rest", it: "juice", qty: -1 }]);
  });
  it("charges the printed MRP when the list price sits above it - the cap is the rate", () => {
    const b = planBill(M, { A: { ...PL.A, juice: 25 }, B: PL.B }, "rest", { juice: 1 });
    expect(b.lines).toEqual([{ it: "juice", qty: 1, rate: 20 }]);  // MRP 20, not the 25 on the list
    expect(b.tot).toBe(20);
  });
});
