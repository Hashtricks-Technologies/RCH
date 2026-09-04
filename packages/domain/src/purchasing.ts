import { istDate } from "./format.js";

/**
 * What buying an order costs, and when it is expected.
 *
 * The slab itself is not declared here: `needsApproval` takes its limit as an argument so the
 * rule and the number stay separable — the number is the contract's (`PO_APPROVAL_LIMIT`), and
 * the caller that enforces the rule passes it in.
 */

/** What an order is worth, before tax and before anything is delivered. */
export const poValue = (lines: readonly { qty: number; rate: number }[]): number =>
  Math.round(lines.reduce((t, l) => t + l.qty * l.rate, 0) * 100) / 100;

/** Strictly over the slab. An order landing exactly on the limit goes out without finance. */
export const needsApproval = (value: number, limit: number): boolean => value > limit;

/** A line is priced off the live rate contract wherever there is one, and off the item's own
 *  standard cost where there is not (spec §9.2, `createPo`). A contract with no rate on it is
 *  not a price. */
export const rateFor = (contract: { rate: number } | undefined, itemCost: number): number =>
  contract && contract.rate > 0 ? contract.rate : itemCost;

/** The expected date a vendor's lead time implies, counted in the hospital's calendar. */
export const etaFrom = (at: Date, leadDays: number): string =>
  istDate(new Date(Date.parse(`${istDate(at)}T00:00:00+05:30`) + Math.max(0, Math.round(leadDays)) * 86_400_000));
