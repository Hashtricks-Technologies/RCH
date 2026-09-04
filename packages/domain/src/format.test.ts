import { describe, expect, it } from "vitest";
import { dmy, istDate, money, money0, unitTotal } from "./format.js";

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

describe("unitTotal (M4)", () => {
  const unitOf = (it: string) => (it === "milk" ? "L" : "nos");
  it("groups by unit rather than summing litres into cups", () => {
    expect(unitTotal([{ it: "milk", qty: 10 }, { it: "cup", qty: 500 }], unitOf)).toBe("10.000 L · 500 nos");
  });
  it("is empty for nothing", () => {
    expect(unitTotal([], unitOf)).toBe("");
  });
});
