import { describe, expect, it } from "vitest";
import { approvedStatus, planApproval, planPrqApproval } from "./approval";

const free = (n: number) => () => n;

describe("planApproval", () => {
  it("approves in full when the store can cover it", () => {
    const p = planApproval([{ it: "sugar", qty: 5 }, { it: "butter", qty: 1 }], [5, 1], free(100));
    expect(p.st).toBe("Manager approved");
    expect(p.trimmed).toBe(false);
    expect(p.lines).toEqual([
      { it: "sugar", qty: 5, appr: 5, short: 0 },
      { it: "butter", qty: 1, appr: 1, short: 0 },
    ]);
  });

  it("never promises more than was asked, and records the shortfall (C4)", () => {
    const p = planApproval([{ it: "milk", qty: 20 }], [999], free(100));
    expect(p.lines[0]).toEqual({ it: "milk", qty: 20, appr: 20, short: 0 });
    expect(p.st).toBe("Manager approved");
    expect(p.trimmed).toBe(false);   // the manager asked for more than the counter did; the ask is the ceiling
  });

  it("clamps to what is still free to promise and flags the trim (C6)", () => {
    const p = planApproval([{ it: "milk", qty: 20 }], [20], free(12));
    expect(p.lines[0]).toEqual({ it: "milk", qty: 20, appr: 12, short: 8 });
    expect(p.st).toBe("Partially approved");
    expect(p.trimmed).toBe(true);
  });

  it("is a rejection when nothing at all can be given", () => {
    const p = planApproval([{ it: "juice", qty: 24 }, { it: "water", qty: 12 }], [0, 0], free(100));
    expect(p.st).toBe("Rejected");
    expect(p.trimmed).toBe(false);   // the manager chose zero; nothing was taken off them
    expect(p.lines.map((l) => l.short)).toEqual([24, 12]);
  });

  it("treats a missing or non-finite entry as zero", () => {
    const p = planApproval([{ it: "milk", qty: 20 }, { it: "sugar", qty: 4 }], [Number.NaN], free(100));
    expect(p.lines.map((l) => l.appr)).toEqual([0, 0]);
    expect(p.st).toBe("Rejected");
  });

  it("rounds to three decimals so a float split does not leak into the ledger", () => {
    const p = planApproval([{ it: "beans", qty: 0.3 }], [0.3], free(0.1 + 0.2));
    expect(p.lines[0].appr).toBe(0.3);
    expect(p.lines[0].short).toBe(0);
  });
});

describe("approvedStatus", () => {
  it("is a full approval when every line got what it asked for", () => {
    expect(approvedStatus([{ qty: 10, appr: 10 }, { qty: 4, appr: 4 }])).toBe("Manager approved");
  });
  it("is a partial approval when any line was trimmed", () => {
    expect(approvedStatus([{ qty: 10, appr: 10 }, { qty: 4, appr: 1 }])).toBe("Partially approved");
  });
  it("is what planApproval itself decides, so a cancelled ticket puts a request back where it was", () => {
    const plan = planApproval([{ it: "milk", qty: 20 }], [20], () => 12);
    expect(plan.st).toBe(approvedStatus(plan.lines));
  });
});

describe("planPrqApproval", () => {
  const lines = [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }];
  it("never approves more than the store keeper asked for", () => {
    const p = planPrqApproval(lines, [999, 6]);
    expect(p.lines.map((l) => l.appr)).toEqual([60, 6]);
    expect(p.st).toBe("Approved");
  });
  it("records the shortfall on a trimmed line", () => {
    const p = planPrqApproval(lines, [40, 6]);
    expect(p.lines[0]).toEqual({ it: "milk", qty: 60, appr: 40, short: 20 });
    expect(p.st).toBe("Partially approved");
  });
  it("is a decline when nothing is approved, and every line's shortfall is the whole ask", () => {
    const p = planPrqApproval(lines, [0, 0]);
    expect(p.st).toBe("Declined");
    expect(p.lines.map((l) => l.short)).toEqual([60, 6]);
  });
  it("reads a missing or negative entry as nothing approved", () => {
    expect(planPrqApproval(lines, [Number.NaN, -5]).st).toBe("Declined");
  });
  it("does not consult free-to-promise — the store's shelf has nothing to do with what a vendor can supply", () => {
    // planApproval takes a freeFor callback; this one deliberately does not have one.
    expect(planPrqApproval.length).toBe(2);
  });
});
