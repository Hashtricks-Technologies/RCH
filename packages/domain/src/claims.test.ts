import { describe, expect, it } from "vitest";
import { foldClaims, releaseClaim, shortfallClaims } from "./claims.js";

const src = [
  { prq: "PRQ-2026-011", line: 0, qty: 25 },
  { prq: "PRQ-2026-012", line: 0, qty: 80 },
];

describe("releaseClaim", () => {
  it("gives back the last source first, so the newest claim is the first to go", () => {
    const { released, left } = releaseClaim(src, 30);
    expect(released).toEqual([{ prq: "PRQ-2026-012", line: 0, qty: 30 }]);
    expect(left).toEqual([{ prq: "PRQ-2026-011", line: 0, qty: 25 }, { prq: "PRQ-2026-012", line: 0, qty: 50 }]);
  });

  it("walks past an exhausted source into the one before it", () => {
    const { released, left } = releaseClaim(src, 95);
    expect(released).toEqual([
      { prq: "PRQ-2026-012", line: 0, qty: 80 },
      { prq: "PRQ-2026-011", line: 0, qty: 15 },
    ]);
    expect(left).toEqual([{ prq: "PRQ-2026-011", line: 0, qty: 10 }]);
  });

  it("returns everything and leaves nothing when the whole line goes", () => {
    const { released, left } = releaseClaim(src, 105);
    expect(released.reduce((t, x) => t + x.qty, 0)).toBe(105);
    expect(left).toEqual([]);
  });

  it("gives nothing back for nothing, and never more than it holds", () => {
    expect(releaseClaim(src, 0).released).toEqual([]);
    expect(releaseClaim(src, 0).left).toEqual([...src]);
    expect(releaseClaim(src, 999).released.reduce((t, x) => t + x.qty, 0)).toBe(105);
  });

  it("keeps three decimals, so a kilo split three ways adds back up", () => {
    const thirds = [{ prq: "P", line: 0, qty: 0.333 }, { prq: "P", line: 1, qty: 0.334 }];
    expect(releaseClaim(thirds, 0.5).released.reduce((t, x) => t + x.qty, 0)).toBeCloseTo(0.5, 3);
  });
});

describe("foldClaims", () => {
  it("adds up every delta against the same requisition line", () => {
    expect(foldClaims([
      { prq: "A", line: 0, qty: 5 }, { prq: "A", line: 0, qty: 7 }, { prq: "A", line: 1, qty: 2 },
    ])).toEqual([{ prq: "A", line: 0, qty: 12 }, { prq: "A", line: 1, qty: 2 }]);
  });
  it("sorts by requisition id, then line — the order every writer takes its locks in", () => {
    expect(foldClaims([{ prq: "B", line: 0, qty: 1 }, { prq: "A", line: 1, qty: 1 }, { prq: "A", line: 0, qty: 1 }])
      .map((x) => `${x.prq}#${x.line}`)).toEqual(["A#0", "A#1", "B#0"]);
  });
});

describe("shortfallClaims", () => {
  it("gives back only what never arrived, last source first", () => {
    expect(shortfallClaims([{ qty: 105, recv: 60, src }])).toEqual([
      { prq: "PRQ-2026-012", line: 0, qty: 45 },
    ]);
  });
  it("gives nothing back on a line that was delivered in full or over", () => {
    expect(shortfallClaims([{ qty: 80, recv: 80, src: [src[1]] }])).toEqual([]);
    expect(shortfallClaims([{ qty: 80, recv: 81, src: [src[1]] }])).toEqual([]);
  });
});
