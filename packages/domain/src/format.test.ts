import { describe, expect, it } from "vitest";
import { dmy, istDate, istDaysBetween, money, money0, splitGst, unitTotal } from "./format.js";

describe("money", () => {
  it("prints rupees the way every screen already prints them", () => {
    expect(money(1234.5)).toBe("₹1,234.50");
    expect(money(0)).toBe("₹0.00");
    expect(money0(1234.5)).toBe("₹1,235");
    expect(money0(25000)).toBe("₹25,000");
  });
});

describe("dmy", () => {
  it("turns a wire date into the one the paperwork carries", () => {
    expect(dmy("2026-08-31")).toBe("31-Aug-2026");
    expect(dmy("2026-01-01")).toBe("01-Jan-2026");
  });
  it("passes anything that is not a wire date straight through", () => {
    expect(dmy("31-Aug-2026")).toBe("31-Aug-2026");
    expect(dmy("")).toBe("");
  });
});

describe("istDate", () => {
  it("reads the calendar date in the hospital's zone, not the host's", () => {
    // 23:30 IST on the 4th is 18:00Z on the 4th; a host in UTC agrees. 00:30 IST on the 5th is
    // 19:00Z on the 4th, and a host in UTC would call that the 4th. The hospital would not.
    expect(istDate(new Date("2026-09-04T18:00:00.000Z"))).toBe("2026-09-04");
    expect(istDate(new Date("2026-09-04T19:00:00.000Z"))).toBe("2026-09-05");
  });
});

describe("istDaysBetween (QA 21-Nov-2026, V9)", () => {
  it("counts hospital calendar days, whatever the host's zone", () => {
    // 17-Sep 21:54 IST to 21-Nov 11:30 IST: 65 days - what the receivables list should read.
    expect(istDaysBetween(new Date("2026-09-17T16:24:45Z"), new Date("2026-11-21T06:00:00Z"))).toBe(65);
    // Past 18:30Z it is already the 22nd in IST.
    expect(istDaysBetween(new Date("2026-09-17T16:24:45Z"), new Date("2026-11-21T18:31:00Z"))).toBe(66);
  });
  it("is zero on the same IST day, even across UTC midnight", () => {
    expect(istDaysBetween(new Date("2026-11-20T19:00:00Z"), new Date("2026-11-21T17:00:00Z"))).toBe(0);
  });
  it("never goes negative for an instant after the reference", () => {
    expect(istDaysBetween(new Date("2026-11-22T06:00:00Z"), new Date("2026-11-21T06:00:00Z"))).toBe(0);
  });
});

describe("splitGst (QA 21-Nov-2026, V3)", () => {
  it("halves the tax and gives the remainder to CGST, so the two lines always add up", () => {
    expect(splitGst(205.15)).toEqual({ sgst: 102.58, cgst: 102.57 });
    expect(splitGst(210.86)).toEqual({ sgst: 105.43, cgst: 105.43 });
    expect(splitGst(0)).toEqual({ sgst: 0, cgst: 0 });
  });
});

describe("unitTotal (M4)", () => {
  const unitOf = (it: string) => (it === "milk" ? "L" : "nos");
  it("groups by unit rather than summing litres into cups", () => {
    expect(unitTotal([{ it: "milk", qty: 10 }, { it: "cup", qty: 500 }], unitOf)).toBe("10.000 L · 500 nos");
  });
  it("is empty for nothing", () => {
    expect(unitTotal([], unitOf)).toBe("");
  });
});
