import { describe, expect, it } from "vitest";
import {
  MAX_DISCOUNT_PCT, creditLimitFor, creditLimitRefusal, discountOn, discountPctFor,
  discountRefusal, validCreditLimit, validDiscountPct,
} from "./discount";

describe("discountPctFor", () => {
  it("gives a person their own rate where the manager set one", () => {
    expect(discountPctFor(20, 25)).toBe(25);
    expect(discountPctFor(20, 0)).toBe(0);      // an exception that is worse than the category is still an exception
  });
  it("falls back to the category where they have none", () => {
    expect(discountPctFor(20, null)).toBe(20);
    expect(discountPctFor(20, undefined)).toBe(20);
  });
});

describe("creditLimitFor", () => {
  it("gives a person their own ceiling where the manager set one, including zero", () => {
    expect(creditLimitFor(null, 5000)).toBe(5000);
    expect(creditLimitFor(3000, 0)).toBe(0);
  });
  it("falls back to the category, and a category of `null` is no ceiling at all", () => {
    expect(creditLimitFor(3000, null)).toBe(3000);
    expect(creditLimitFor(3000, undefined)).toBe(3000);
    expect(creditLimitFor(null, null)).toBeNull();
  });
});

describe("discountOn", () => {
  it("takes the percentage off, to the paisa", () => {
    expect(discountOn(1000, 20)).toBe(200);
    expect(discountOn(250, 12.5)).toBe(31.25);
    expect(discountOn(0, 80)).toBe(0);
    expect(discountOn(1000, 0)).toBe(0);
    expect(discountOn(1000, 100)).toBe(1000);
  });
  it("rounds once rather than carrying a float the rest of the way", () => {
    expect(discountOn(33.33, 10)).toBe(3.33);
    expect(discountOn(0.1 + 0.2, 50)).toBe(0.15);
  });
});

describe("what the manager may type", () => {
  it("takes a rate from nothing to everything, and refuses the rest", () => {
    expect(MAX_DISCOUNT_PCT).toBe(100);
    for (const p of [0, 10, 12.5, 80, 100]) expect(validDiscountPct(p), String(p)).toBe(true);
    for (const p of [-1, 100.01, 101, Number.NaN, Number.POSITIVE_INFINITY]) expect(validDiscountPct(p), String(p)).toBe(false);
  });
  it("takes a ceiling of nothing, zero, or an amount, and refuses a negative one", () => {
    for (const l of [null, 0, 3000]) expect(validCreditLimit(l), String(l)).toBe(true);
    for (const l of [-1, Number.NaN]) expect(validCreditLimit(l), String(l)).toBe(false);
  });
  it("says why, in the words both sides print", () => {
    expect(discountRefusal(120)).toBe("Refused - 120% is not a discount; give a rate between 0% and 100%");
    expect(creditLimitRefusal(-500)).toBe("Refused - ₹-500.00 is not a credit limit; give nothing for no limit, or an amount that is not negative");
  });
});
