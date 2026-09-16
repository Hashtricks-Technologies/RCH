import { describe, expect, it } from "vitest";
import { allocateSettlement, nothingOwedMessage, settlementOverpayMessage, type OpenBill } from "./settlement";

const bill = (no: string, at: string, owed: number): OpenBill => ({ no, at, owed });

describe("allocateSettlement", () => {
  it("closes the oldest bills first", () => {
    const open = [
      bill("CF/3", "2026-09-03T04:00:00.000Z", 100),
      bill("CF/1", "2026-09-01T04:00:00.000Z", 100),
      bill("CF/2", "2026-09-02T04:00:00.000Z", 100),
    ];
    expect(allocateSettlement(open, 250)).toEqual({
      lines: [{ no: "CF/1", amount: 100 }, { no: "CF/2", amount: 100 }, { no: "CF/3", amount: 50 }],
      left: 0,
    });
  });

  it("part-settles at most one bill, and always the newest one it reached", () => {
    const open = [bill("CF/1", "2026-09-01T04:00:00.000Z", 80), bill("CF/2", "2026-09-02T04:00:00.000Z", 80)];
    expect(allocateSettlement(open, 100).lines).toEqual([{ no: "CF/1", amount: 80 }, { no: "CF/2", amount: 20 }]);
  });

  it("stops when the money runs out and leaves the rest of the bills alone", () => {
    const open = [bill("CF/1", "2026-09-01T04:00:00.000Z", 40), bill("CF/2", "2026-09-02T04:00:00.000Z", 40)];
    expect(allocateSettlement(open, 40)).toEqual({ lines: [{ no: "CF/1", amount: 40 }], left: 0 });
  });

  it("reports what it could not place, which is what the overpay refusal is built on", () => {
    const open = [bill("CF/1", "2026-09-01T04:00:00.000Z", 40)];
    expect(allocateSettlement(open, 100)).toEqual({ lines: [{ no: "CF/1", amount: 40 }], left: 60 });
    expect(allocateSettlement([], 100)).toEqual({ lines: [], left: 100 });
  });

  it("skips a bill that is already fully settled rather than writing a zero line", () => {
    const open = [bill("CF/1", "2026-09-01T04:00:00.000Z", 0), bill("CF/2", "2026-09-02T04:00:00.000Z", 50)];
    expect(allocateSettlement(open, 50).lines).toEqual([{ no: "CF/2", amount: 50 }]);
  });

  it("keeps the lines adding back up to the payment, to the paisa", () => {
    const open = [
      bill("CF/1", "2026-09-01T04:00:00.000Z", 33.33),
      bill("CF/2", "2026-09-02T04:00:00.000Z", 33.33),
      bill("CF/3", "2026-09-03T04:00:00.000Z", 33.34),
    ];
    const { lines, left } = allocateSettlement(open, 100);
    expect(lines.reduce((t, l) => t + l.amount, 0)).toBe(100);
    expect(left).toBe(0);
  });

  it("does not reorder the caller's own list", () => {
    const open = [bill("CF/2", "2026-09-02T04:00:00.000Z", 10), bill("CF/1", "2026-09-01T04:00:00.000Z", 10)];
    allocateSettlement(open, 20);
    expect(open.map((b) => b.no)).toEqual(["CF/2", "CF/1"]);
  });
});

describe("the refusals", () => {
  it("names what is actually owed, so it can be corrected without going to look", () => {
    expect(settlementOverpayMessage(4500, 3200, "Dr A. Rao · Cardiology"))
      .toBe("Refused - ₹4,500.00 is more than the ₹3,200.00 Dr A. Rao · Cardiology still owes");
    expect(nothingOwedMessage("Nursing")).toBe("Refused - Nursing owes nothing");
  });
});
