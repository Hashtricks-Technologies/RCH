import { describe, expect, it, vi } from "vitest";
import { dateAt, iso, todayAt } from "./time.js";

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

describe("iso", () => {
  it("round-trips a Date through its ISO string", () => {
    const d = new Date("2026-09-03T01:00:00.000Z");
    expect(iso(d)).toBe("2026-09-03T01:00:00.000Z");
  });
});
