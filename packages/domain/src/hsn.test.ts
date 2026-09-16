import { describe, expect, it } from "vitest";
import { gstForHsn, HSN_CODES, hsnGroups } from "./hsn";

describe("HSN_CODES", () => {
  it("carries no duplicate code - the picker's value has to resolve to exactly one entry", () => {
    const codes = HSN_CODES.map((e) => e.hsn);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("every entry has a GST rate from 0 to 28", () => {
    for (const e of HSN_CODES) expect(e.gst).toBeGreaterThanOrEqual(0);
    for (const e of HSN_CODES) expect(e.gst).toBeLessThanOrEqual(28);
  });

  it("every entry is filed under a heading, so none can be dropped from the picker", () => {
    for (const e of HSN_CODES) expect(e.category.length).toBeGreaterThan(0);
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

describe("hsnGroups", () => {
  it("draws the headings in the one order both forms read", () => {
    expect(hsnGroups().map((g) => g.category)).toEqual([
      "Dairy & eggs",
      "Bakery",
      "Grocery & staples",
      "Beverages",
      "Snacks & confectionery",
      "Packaging",
      "Cleaning & disposables",
    ]);
  });

  it("puts every code in exactly one group, and leaves none out", () => {
    const grouped = hsnGroups().flatMap((g) => g.entries.map((e) => e.hsn));
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(grouped.sort()).toEqual(HSN_CODES.map((e) => e.hsn).sort());
  });

  it("leaves no heading empty - an empty optgroup is a heading over nothing", () => {
    for (const g of hsnGroups()) expect(g.entries.length).toBeGreaterThan(0);
  });

  it("is stable: the same headings and the same codes in the same places, call after call", () => {
    expect(hsnGroups()).toEqual(hsnGroups());
  });

  it("keeps each entry's own rate, so a picked code still answers gstForHsn", () => {
    const beverages = hsnGroups().find((g) => g.category === "Beverages")!;
    expect(beverages.entries.map((e) => e.hsn)).toEqual(["0901", "0902", "2101", "2009", "2201", "2202"]);
    expect(beverages.entries.find((e) => e.hsn === "2202")!.gst).toBe(28);
  });
});
