import { describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import type { Location } from "@rch/contract";
import { parFactor } from "./par";

describe("parFactor", () => {
  it("reads the factor off the location, and a full day where the location carries none", () => {
    expect(parFactor(FX.LOC, "rest")).toBe(0.22);
    expect(parFactor(FX.LOC, "store")).toBe(1);
    // A test double standing in for a location the wire never actually sends without a `par` -
    // the fallback is insurance for that case too, not only for a key missing outright below.
    expect(parFactor({ x: { n: "X", c: "X", type: "Outlet", floor: "G", cc: "C" } as Location }, "x")).toBe(1);
    expect(parFactor(FX.LOC, "nowhere")).toBe(1);
  });
});
