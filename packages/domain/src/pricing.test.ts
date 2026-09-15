import { describe, expect, it } from "vitest";
import { IT, LOC, PL } from "@rch/contract/fixtures";
import { priceOf } from "./pricing";
const M = { items: IT, locations: LOC };
describe("priceOf", () => {
  it("reads the location's list", () => { expect(priceOf(M, PL, "rest", "capp")).toEqual({ p: 60, listed: 60, capped: false }); expect(priceOf(M, PL, "coffee", "capp").p).toBe(75); });
  it("caps a traded item at its printed MRP", () => {
    const prices = { ...PL, "PL-001": { ...PL["PL-001"], juice: 25 } };
    expect(priceOf(M, prices, "rest", "juice")).toEqual({ p: 20, listed: 25, capped: true });
  });
  it("is zero for a location without a list or an unlisted item", () => { expect(priceOf(M, PL, "store", "capp").p).toBe(0); expect(priceOf(M, PL, "rest", "milk").p).toBe(0); });
  it("reads any number of lists, not just two fixed ones", () => {
    const m = { items: IT, locations: { ...LOC, rest: { ...LOC.rest, list: "PL-009" } } };
    const prices = { "PL-009": { capp: 60 } };
    expect(priceOf(m, prices, "rest", "capp")).toEqual({ p: 60, listed: 60, capped: false });
  });
});
