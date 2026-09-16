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
    const b = planBill(M, { ...PL, "PL-001": { ...PL["PL-001"], juice: 25 } }, "rest", { juice: 1 });
    expect(b.lines).toEqual([{ it: "juice", qty: 1, rate: 20 }]);  // MRP 20, not the 25 on the list
    expect(b.tot).toBe(20);
  });
  it("takes nothing off when nobody set a rate, which is what a walk-in customer pays", () => {
    const b = planBill(M, PL, "coffee", { juice: 2, chips: 2, bisc: 1 });
    expect(b.disc).toBe(0);
    expect(b.tot).toBe(110);
  });
  it("takes the party's rate off, and `tot + disc` is what the shelf price added up to", () => {
    const b = planBill(M, PL, "coffee", { juice: 2, chips: 2, bisc: 1 }, 20);
    expect(b.disc).toBe(22);
    expect(b.tot).toBe(88);
    // The printed price stays on the line: a bill has to show what the product costs as well as
    // what this person paid for it.
    expect(b.lines).toEqual([{ it: "juice", qty: 2, rate: 20 }, { it: "chips", qty: 2, rate: 20 }, { it: "bisc", qty: 1, rate: 30 }]);
  });
  it("derives GST from what is actually charged, slab by slab", () => {
    // Taken off the line rather than off the total, so a mixed cart splits the concession across
    // its slabs instead of putting all of it on one of them.
    const b = planBill(M, PL, "coffee", { juice: 2, chips: 2, bisc: 1 }, 20);
    expect(b.tax).toBeCloseTo(32 - 32 / 1.12 + 32 - 32 / 1.12 + 24 - 24 / 1.18, 6);
  });
  it("still moves the whole quantity off the shelf - a discount is money, not stock", () => {
    const b = planBill(M, PL, "coffee", { juice: 2 }, 50);
    expect(b.moves).toEqual([{ loc: "coffee", it: "juice", qty: -2 }]);
  });
  it("gives a hundred per cent away, which is a department's hospitality budget", () => {
    const b = planBill(M, PL, "coffee", { juice: 2 }, 100);
    expect(b.tot).toBe(0);
    expect(b.disc).toBe(40);
    expect(b.tax).toBe(0);
  });
});
