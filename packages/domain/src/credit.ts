import { STAFF_CREDIT_LIMIT } from "@rch/contract";
import { money, money0 } from "./format.js";

/**
 * How far a party may run before the till stops them.
 *
 * This used to be a calendar-month figure with one number compiled into it, because nothing
 * could bring a balance down except voiding the bill on the day it was taken - so "what they
 * have taken this month" was the only honest measure of exposure there was. Now that a
 * settlement exists, the number that decides a sale is what is **unsettled**: a doctor who
 * clears their account on the 15th can buy coffee on the 16th, which is what everybody meant by
 * a monthly account all along.
 *
 * The ceiling is the outlet manager's, per category and per person, and `null` means there is
 * none. `null` is not zero: a consultant nobody wants the till arguing with has no limit, and a
 * department switched off for the month has a limit of zero. Both are things somebody meant.
 */

// Re-exported, never redeclared. It is no longer the rule's constant - only the number the
// `staff` row of the rate card is seeded with, so a hospital that never opens the screen behaves
// exactly as it always has.
export { STAFF_CREDIT_LIMIT };

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** How much more this party may put on their account before the ceiling. Never negative, and
 *  `null` where there is no ceiling - a screen prints "no limit" rather than a number nobody set. */
export const creditRoom = (outstanding: number, limit: number | null): number | null =>
  limit === null ? null : Math.max(0, round2(limit - outstanding));

/** Whether this bill would take them past it. Landing exactly on the ceiling is allowed, and a
 *  party with no ceiling is never refused. */
export const breachesCredit = (outstanding: number, total: number, limit: number | null): boolean =>
  limit !== null && round2(outstanding + total) > limit;

/**
 * The refusal, in the operator's own words, said once and printed word for word by the server
 * that refuses and the till that saw it coming. It names the balance the bill would reach rather
 * than the bill itself, because the balance is the thing the ceiling is about - and it names the
 * door that is open, which is a settlement or a different tender.
 */
export const creditBreachMessage = (
  outstanding: number, total: number, payerName: string, limit: number,
): string =>
  `${money(outstanding + total)} breaches the ${money0(limit)} credit limit for ${payerName}. Settle the account, take another tender, or split the bill.`;
