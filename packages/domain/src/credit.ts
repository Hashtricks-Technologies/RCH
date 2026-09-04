import { STAFF_CREDIT_LIMIT } from "@rch/contract";
import { money, money0 } from "./format.js";

/** Re-exported so a caller enforcing the rule takes the rule and its ceiling from one place.
 *  The number is declared in @rch/contract (packages/domain may depend on it, not the reverse). */
export { STAFF_CREDIT_LIMIT };

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** How much more this person may put on credit before the ceiling. Never negative. */
export const creditRoom = (taken: number, limit: number = STAFF_CREDIT_LIMIT): number =>
  Math.max(0, round2(limit - taken));

/** Whether this bill would take them past it. Landing exactly on the ceiling is allowed. */
export const breachesCredit = (taken: number, total: number, limit: number = STAFF_CREDIT_LIMIT): boolean =>
  round2(taken + total) > limit;

/**
 * The one sentence both sides say. The counter's screen has explained the breach this way
 * since before there was a server (`UI/src/roles/counter/Pos.tsx`), so the server's refusal
 * repeats it word for word rather than inventing a second wording for the same fact.
 */
export const creditBreachMessage = (
  taken: number, total: number, payerName: string, limit: number = STAFF_CREDIT_LIMIT,
): string =>
  `${money(taken + total)} breaches the ${money0(limit)} staff credit limit for ${payerName}. Take another tender or split the bill.`;
