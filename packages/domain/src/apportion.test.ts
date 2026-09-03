import { describe, expect, it } from "vitest";
import { apportion } from "./apportion";

describe("apportion", () => {
  it("fills sources in order and stops when the receipt runs out", () => {
    expect(apportion(7, [{ qty: 5 }, { qty: 5 }])).toEqual([5, 2]);
  });
  it("never gives a source more than it asked for", () => {
    expect(apportion(20, [{ qty: 5 }, { qty: 5 }])).toEqual([5, 5]);
  });
  it("handles fractional quantities to three decimals", () => {
    expect(apportion(1.5, [{ qty: 1.2 }, { qty: 1.2 }])).toEqual([1.2, 0.3]);
  });
});
