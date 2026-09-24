import { describe, expect, it } from "vitest";
import { TenderSchema, TillTenderSchema } from "./common";
import { PayBodySchema, SavePriceBodySchema } from "./writes";

const body = (over: Record<string, unknown> = {}) => ({ loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }], ...over });

describe("PayBodySchema", () => {
  it("takes the six tenders the counter offers, and nothing else - never Online", () => {
    expect(TenderSchema.options).toEqual(["Cash", "UPI", "Card", "Staff credit", "Doctor credit", "Dept", "Online"]);
    expect(TillTenderSchema.options).toEqual(["Cash", "UPI", "Card", "Staff credit", "Doctor credit", "Dept"]);
    for (const tender of TillTenderSchema.options) expect(PayBodySchema.safeParse(body({ tender })).success, tender).toBe(true);
    // A bill paid online is raised by a QR order's capture, never by a till.
    expect(PayBodySchema.safeParse(body({ tender: "Online" })).success).toBe(false);
    // A tender is a closed set: a near miss is a validation error, not a bill settled by "staff credit".
    for (const tender of ["staff credit", "cash", "Cheque", ""]) expect(PayBodySchema.safeParse(body({ tender })).success, tender).toBe(false);
  });

  it("takes a quantity to three decimals and refuses a finer one", () => {
    for (const qty of [1, 2.5, 0.001, 0.15, 12.345, 10000]) expect(PayBodySchema.safeParse(body({ lines: [{ it: "juice", qty }] })).success, String(qty)).toBe(true);
    for (const qty of [0.0005, 0.0001, 2.00001, 0, -1, 10001]) expect(PayBodySchema.safeParse(body({ lines: [{ it: "juice", qty }] })).success, String(qty)).toBe(false);
  });

  it("takes an optional customer name, trimmed and at most 80 characters, and a phone left for the service to judge", () => {
    expect(PayBodySchema.parse(body({ customerName: "  Anitha  ", customerPhone: "98430 22118" }))).toMatchObject({ customerName: "Anitha", customerPhone: "98430 22118" });
    expect(PayBodySchema.parse(body())).not.toHaveProperty("customerName");
    expect(PayBodySchema.safeParse(body({ customerName: "x".repeat(81) })).success).toBe(false);
    expect(PayBodySchema.safeParse(body({ customerPhone: "9".repeat(21) })).success).toBe(false);
  });
});

describe("SavePriceBodySchema", () => {
  it("refuses a price of nothing", () => {
    expect(SavePriceBodySchema.safeParse({ price: 19 }).success).toBe(true);
    expect(SavePriceBodySchema.safeParse({ price: 0 }).success).toBe(false);
    expect(SavePriceBodySchema.safeParse({ price: -1 }).success).toBe(false);
  });
});
