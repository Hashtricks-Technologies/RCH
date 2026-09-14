import { describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import { PAR_FACTOR, parFactor } from "./par";

describe("PAR_FACTOR", () => {
  it("carries one factor per location - a full day at the store, a fraction of one at every shop", () => {
    // The five literals, not a formula that reproduces them: these numbers are a judgement about
    // how much cover each place needs, and a test that recomputed them would agree with any
    // change made to them.
    expect(PAR_FACTOR).toEqual({ store: 1, kitchen: 0.35, rest: 0.22, coffee: 0.18, kiosk: 0.15 });
  });
});

describe("parFactor", () => {
  it("reads the factor off the location, and a full day where the location carries none", () => {
    expect(parFactor(FX.LOC, "rest")).toBe(0.22);
    expect(parFactor(FX.LOC, "store")).toBe(1);
    expect(parFactor({ x: { n: "X", c: "X", type: "Outlet", floor: "G", cc: "C" } }, "x")).toBe(1);
    expect(parFactor(FX.LOC, "nowhere")).toBe(1);
  });
});
