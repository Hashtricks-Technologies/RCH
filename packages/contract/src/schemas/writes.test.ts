import { describe, expect, it } from "vitest";
import { TenderSchema } from "./common";
import { PayBodySchema, SavePriceBodySchema } from "./writes";

const body = (over: Record<string, unknown> = {}) => ({ loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }], ...over });

describe("PayBodySchema", () => {
  it("takes the six tenders the counter offers, and nothing else", () => {
    expect(TenderSchema.options).toEqual(["Cash", "UPI", "Card", "Patient bill", "Staff credit", "Dept"]);
    for (const tender of TenderSchema.options) expect(PayBodySchema.safeParse(body({ tender })).success, tender).toBe(true);
    // A tender is a closed set: a near miss is a validation error, not a bill settled by "staff credit".
    for (const tender of ["staff credit", "cash", "Cheque", ""]) expect(PayBodySchema.safeParse(body({ tender })).success, tender).toBe(false);
  });

  it("takes a quantity to three decimals and refuses a finer one", () => {
    for (const qty of [1, 2.5, 0.001, 0.15, 12.345, 10000]) expect(PayBodySchema.safeParse(body({ lines: [{ it: "juice", qty }] })).success, String(qty)).toBe(true);
    for (const qty of [0.0005, 0.0001, 2.00001, 0, -1, 10001]) expect(PayBodySchema.safeParse(body({ lines: [{ it: "juice", qty }] })).success, String(qty)).toBe(false);
  });
});

describe("SavePriceBodySchema", () => {
  it("refuses a price of nothing", () => {
    expect(SavePriceBodySchema.safeParse({ price: 19 }).success).toBe(true);
    expect(SavePriceBodySchema.safeParse({ price: 0 }).success).toBe(false);
    expect(SavePriceBodySchema.safeParse({ price: -1 }).success).toBe(false);
  });
});
