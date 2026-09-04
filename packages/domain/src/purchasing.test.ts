import { describe, expect, it } from "vitest";
import { etaFrom, needsApproval, poValue, rateFor } from "./purchasing.js";

describe("poValue and needsApproval", () => {
  it("values an order at quantity times rate", () => {
    expect(poValue([{ qty: 120, rate: 14.2 }, { qty: 90, rate: 11.5 }])).toBeCloseTo(2739, 2);
  });
  it("is over the slab strictly, so landing exactly on it does not need finance", () => {
    expect(needsApproval(25000, 25000)).toBe(false);
    expect(needsApproval(25000.01, 25000)).toBe(true);
  });
});

describe("rateFor", () => {
  it("prices off the live contract when there is one", () => {
    expect(rateFor({ rate: 52 }, 54)).toBe(52);
  });
  it("falls back to the item's own cost when there is not", () => {
    expect(rateFor(undefined, 54)).toBe(54);
  });
  it("ignores a contract with no rate on it", () => {
    expect(rateFor({ rate: 0 }, 54)).toBe(54);
  });
});

describe("etaFrom", () => {
  it("is the vendor's lead time from today, in the hospital's calendar", () => {
    expect(etaFrom(new Date("2026-08-29T18:00:00.000Z"), 2)).toBe("2026-08-31");
    expect(etaFrom(new Date("2026-08-29T19:00:00.000Z"), 2)).toBe("2026-09-01");  // already the 30th in IST
    expect(etaFrom(new Date("2026-08-29T06:00:00.000Z"), 0)).toBe("2026-08-29");
  });
});
