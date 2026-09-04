import { describe, expect, it, vi } from "vitest";
import { dateAt, iso, monthStartIST, todayAt } from "./time.js";

describe("dateAt", () => {
  it("interprets the calendar date + HH:MM as IST, a fixed +05:30 offset", () => {
    expect(dateAt("2026-09-03", "06:30").toISOString()).toBe("2026-09-03T01:00:00.000Z");
    expect(dateAt("2026-01-01", "00:00").toISOString()).toBe("2025-12-31T18:30:00.000Z");
  });
});

describe("todayAt", () => {
  it("uses today's date in Asia/Kolkata, not the host's local date", () => {
    // Fix "now" to a moment that is already tomorrow in UTC but still today (23:59 IST-ish)
    // relative to Kolkata, to prove the date component comes from the Kolkata calendar.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T20:00:00.000Z")); // 2026-09-04T01:30 IST
    expect(todayAt("06:30")).toEqual(dateAt("2026-09-04", "06:30"));
    vi.useRealTimers();
  });
});

describe("monthStartIST", () => {
  it("is midnight on the first, in the hospital's zone", () => {
    // 14-Sep-2026 09:00 IST -> 01-Sep-2026 00:00 IST, which is 31-Aug-2026 18:30 UTC.
    expect(monthStartIST(new Date("2026-09-14T03:30:00.000Z")).toISOString()).toBe("2026-08-31T18:30:00.000Z");
  });

  it("uses the Indian calendar day, not UTC's", () => {
    // 31-Aug-2026 20:00 UTC is already 01-Sep 01:30 IST: the September window, not August's.
    expect(monthStartIST(new Date("2026-08-31T20:00:00.000Z")).toISOString()).toBe("2026-08-31T18:30:00.000Z");
    // 01-Sep-2026 00:30 UTC is still 01-Sep 06:00 IST: the same window.
    expect(monthStartIST(new Date("2026-09-01T00:30:00.000Z")).toISOString()).toBe("2026-08-31T18:30:00.000Z");
    // 31-Aug-2026 17:00 UTC is 31-Aug 22:30 IST: still August's window.
    expect(monthStartIST(new Date("2026-08-31T17:00:00.000Z")).toISOString()).toBe("2026-07-31T18:30:00.000Z");
  });
});

describe("iso", () => {
  it("round-trips a Date through its ISO string", () => {
    const d = new Date("2026-09-03T01:00:00.000Z");
    expect(iso(d)).toBe("2026-09-03T01:00:00.000Z");
  });
});
