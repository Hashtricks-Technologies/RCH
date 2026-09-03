import { describe, expect, it } from "vitest";
import { IT, LOC, RCP } from "@rch/contract/fixtures";
import { costOf, recipeCost } from "./costing";
const M = { items: IT, locations: LOC, recipes: RCP };
describe("costing", () => {
  it("a made item costs its recipe plus overhead, never zero", () => {
    const raw = 0.15 * 52 + 0.012 * 640 + 0.006 * 46 + 1 * 0.62;
    expect(recipeCost(M, "capp")).toBeCloseTo(raw * 1.12, 6); expect(costOf(M, "capp")).toBeCloseTo(raw * 1.12, 6);
  });
  it("a traded item costs its cost", () => { expect(costOf(M, "juice")).toBe(14.2); expect(recipeCost(M, "juice")).toBe(0); });
});
