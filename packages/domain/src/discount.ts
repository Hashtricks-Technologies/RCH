import { money } from "./format.js";

/**
 * What comes off a bill, and who decides it.
 *
 * A consultant is charged less than a walk-in, a member of staff less again, and a department
 * may have agreed on far less than either. The outlet manager sets one rate per category and,
 * where the hospital has agreed something different with one person, a rate for that person
 * alone. Nothing here reads a clock or a database: the two numbers are handed in, and the answer
 * is arithmetic the server applies inside the sale's own transaction and the till previews with.
 */

/** A discount is a percentage, and a hundred per cent is a giveaway rather than a mistake - a
 *  department's hospitality budget is a real thing. Above that is not a discount at all. */
export const MAX_DISCOUNT_PCT = 100;

/** The rate that applies: a person's own where the manager set one, their category's otherwise.
 *  `null` is "inherit", which is why a person on 0% is not the same as a person on nothing. */
export const discountPctFor = (classPct: number, personPct: number | null | undefined): number =>
  personPct ?? classPct;

/** The ceiling that applies, by the same rule. `null` means no ceiling at all - a consultant the
 *  till is not meant to argue with - and is not the same as 0, which would refuse every sale. */
export const creditLimitFor = (classLimit: number | null, personLimit: number | null | undefined): number | null =>
  personLimit !== undefined && personLimit !== null ? personLimit : classLimit;

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** What `pct` takes off `amount`, to the paisa. Rounded once, here, so the bill's discount and
 *  the sum of its lines can never disagree by a rounding step. */
export const discountOn = (amount: number, pct: number): number => round2(amount * pct / 100);

/** Whether a rate the manager typed is one this system will store. */
export const validDiscountPct = (pct: number): boolean =>
  Number.isFinite(pct) && pct >= 0 && pct <= MAX_DISCOUNT_PCT;

/** Said once, printed by both sides. */
export const discountRefusal = (pct: number): string =>
  `Refused - ${pct}% is not a discount; give a rate between 0% and ${MAX_DISCOUNT_PCT}%`;

/** And the same for a ceiling. Zero is allowed and means it: a department switched off for the
 *  month is an ordinary thing to want, and it is not the same as `null`. */
export const validCreditLimit = (limit: number | null): boolean =>
  limit === null || (Number.isFinite(limit) && limit >= 0);
export const creditLimitRefusal = (limit: number): string =>
  `Refused - ${money(limit)} is not a credit limit; give nothing for no limit, or an amount that is not negative`;
