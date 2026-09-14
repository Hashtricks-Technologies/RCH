import type { ItemType } from "@rch/contract";
import { istDate } from "./format.js";

/**
 * What buying an order costs, and when it is expected.
 *
 * The slab itself is not declared here: `needsApproval` takes its limit as an argument so the
 * rule and the number stay separable — the number is the contract's (`PO_APPROVAL_LIMIT`), and
 * the caller that enforces the rule passes it in.
 */

/** Procurement buys what the central store shelves: raw, packing and MRP goods. A finished good
 *  is made in the kitchen and a made-to-order item is assembled at the counter, so neither is
 *  ever put on the procurement list — the buyer's direct add refuses one, and its picker offers
 *  only what this answers `true` for. */
export const isPurchased = (t: ItemType): boolean => t === "RAW" || t === "PACK" || t === "MRP";

/** What an order is worth, before tax and before anything is delivered. */
export const poValue = (lines: readonly { qty: number; rate: number }[]): number =>
  Math.round(lines.reduce((t, l) => t + l.qty * l.rate, 0) * 100) / 100;

/** Strictly over the slab. An order landing exactly on the limit goes out without finance. */
export const needsApproval = (value: number, limit: number): boolean => value > limit;

/** A line is priced off the live rate contract wherever there is one, and off the item's own
 *  standard cost where there is not. A contract with no rate on it is
 *  not a price. */
export const rateFor = (contract: { rate: number } | undefined, itemCost: number): number =>
  contract && contract.rate > 0 ? contract.rate : itemCost;

/** The expected date a vendor's lead time implies, counted in the hospital's calendar. */
export const etaFrom = (at: Date, leadDays: number): string =>
  istDate(new Date(Date.parse(`${istDate(at)}T00:00:00+05:30`) + Math.max(0, Math.round(leadDays)) * 86_400_000));

/** Is this contract's validity window open on `today`? All three dates are ISO `YYYY-MM-DD`,
 *  which sorts the same as it compares, so a plain string comparison is exact — the same test
 *  `purchaseOrdersRepo.activeContractRates` runs in SQL (`validFrom <= today <= validTo`) to
 *  price an order, so a preview never offers a rate the order will not get. A contract whose
 *  window has closed does not price an order, however active its flag says it is. */
export const contractInWindow = (c: { from: string; to: string }, today: string): boolean =>
  c.from <= today && today <= c.to;
