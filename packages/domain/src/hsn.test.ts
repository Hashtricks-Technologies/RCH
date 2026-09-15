import { describe, expect, it } from "vitest";
import { gstForHsn, HSN_CODES } from "./hsn";

describe("HSN_CODES", () => {
  it("carries no duplicate code - the picker's value has to resolve to exactly one entry", () => {
    const codes = HSN_CODES.map((e) => e.hsn);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("every entry has a GST rate from 0 to 28", () => {
    for (const e of HSN_CODES) expect(e.gst).toBeGreaterThanOrEqual(0);
    for (const e of HSN_CODES) expect(e.gst).toBeLessThanOrEqual(28);
  });
});

describe("gstForHsn", () => {
  it("answers the rate a listed code carries", () => {
    expect(gstForHsn("0401")).toBe(0);
    expect(gstForHsn("2202")).toBe(28);
  });

  it("trims what it is given, so a code copied with stray spaces still resolves", () => {
    expect(gstForHsn(" 0401 ")).toBe(0);
  });

  it("answers nothing for a code typed by hand that is not on the list", () => {
    expect(gstForHsn("9999")).toBeUndefined();
  });
});
