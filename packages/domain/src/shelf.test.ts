import { describe, expect, it } from "vitest";
import { DEFAULT_SHELF_LIFE_HOURS, bestBeforeAt, bestBeforeText } from "./shelf.js";

/** Instants are written in IST so the case reads the way the kitchen would say it. */
const ist = (s: string) => new Date(`${s}+05:30`);

describe("bestBeforeAt", () => {
  it("adds the item's shelf life to the moment it was made", () => {
    expect(bestBeforeAt(ist("2026-08-29T06:40:00"), 12).toISOString()).toBe(ist("2026-08-29T18:40:00").toISOString());
  });

  it("keeps an item with no shelf life recorded for the working day", () => {
    expect(DEFAULT_SHELF_LIFE_HOURS).toBe(8);
    expect(bestBeforeAt(ist("2026-08-29T06:40:00")).toISOString()).toBe(ist("2026-08-29T14:40:00").toISOString());
    expect(bestBeforeAt(ist("2026-08-29T06:40:00"), undefined).toISOString()).toBe(ist("2026-08-29T14:40:00").toISOString());
  });
});

describe("bestBeforeText (H9)", () => {
  it("leaves a same-day best-before as a plain time", () => {
    const made = ist("2026-08-29T06:40:00");
    expect(bestBeforeText(bestBeforeAt(made, 12), made)).toBe("18:40");
  });

  it("says so when the best-before lands on the next day", () => {
    const made = ist("2026-08-29T20:34:00");
    expect(bestBeforeText(bestBeforeAt(made, 12), made)).toBe("08:34 tomorrow");
  });

  it("names the date when it is further out than tomorrow", () => {
    const made = ist("2026-08-29T20:34:00");
    expect(bestBeforeText(bestBeforeAt(made, 48), made)).toMatch(/^20:34 31 Aug$/);
  });
  // ^ This is a new exact-ICU assertion: no existing test pins `en-IN` + `{ day: "2-digit",
  // month: "short" }`. Run it on Node 24 before keeping the anchor — if the runtime spells the
  // month differently, loosen to /^20:34 31 \w{3}\.?$/ rather than changing the formatter,
  // which has to keep matching what `fromWireBestBefore` has always printed.

  it("measures the day boundary in the hospital's zone, not the host's", () => {
    // 23:30 IST on the 29th, due 00:30 IST on the 30th. A host running in UTC sees both
    // instants on the 29th and would call it "tonight"; the kitchen would not.
    const made = new Date("2026-08-29T18:00:00.000Z");
    const due = new Date("2026-08-29T19:00:00.000Z");
    expect(bestBeforeText(due, made)).toBe("00:30 tomorrow");
  });
});
