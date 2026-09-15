import { describe, expect, it } from "vitest";
import { istDay, istDayStart, nextIstDay } from "./time.js";

describe("IST days", () => {
  it("names the hospital's day an instant falls on, not the host's", () => {
    expect(new Date(0).getTimezoneOffset()).toBe(0);   // the suite runs under TZ=UTC
    expect(istDay(new Date("2025-09-13T18:29:59.999Z"))).toBe("2025-09-13");
    expect(istDay(new Date("2025-09-13T18:30:00.000Z"))).toBe("2025-09-14");
  });

  it("starts a day at IST midnight and the next one 24 hours later", () => {
    const start = istDayStart("2025-09-14");
    expect(start?.toISOString()).toBe("2025-09-13T18:30:00.000Z");
    expect(nextIstDay(start!).toISOString()).toBe("2025-09-14T18:30:00.000Z");
    expect(istDayStart("2024-02-29")?.toISOString()).toBe("2024-02-28T18:30:00.000Z");
  });

  it("has no start for a day the calendar does not have", () => {
    expect(istDayStart("2025-02-30")).toBeNull();   // Date would roll it into March
    expect(istDayStart("2025-13-01")).toBeNull();   // Date cannot read it at all
  });
});
