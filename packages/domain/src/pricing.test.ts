import { describe, expect, it } from "vitest";
import { IT, LOC, PL, RCP } from "@rch/contract/fixtures";
import { priceOf } from "./pricing";
const M = { items: IT, locations: LOC, recipes: RCP };
describe("priceOf", () => {
  it("reads the location's list", () => { expect(priceOf(M, PL, "rest", "capp")).toEqual({ p: 60, listed: 60, capped: false }); expect(priceOf(M, PL, "coffee", "capp").p).toBe(75); });
  it("caps a traded item at its printed MRP", () => {
    const prices = { A: { ...PL.A, juice: 25 }, B: PL.B };
    expect(priceOf(M, prices, "rest", "juice")).toEqual({ p: 20, listed: 25, capped: true });
  });
  it("is zero for a location without a list or an unlisted item", () => { expect(priceOf(M, PL, "store", "capp").p).toBe(0); expect(priceOf(M, PL, "rest", "milk").p).toBe(0); });
});
