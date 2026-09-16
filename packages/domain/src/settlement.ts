import { money } from "./format.js";

/**
 * Turning a payment into the bills it closes.
 *
 * Somebody hands over ₹4,200 against the month. That is one payment, but it settles a run of
 * small bills, and the hospital has to be able to say which. Oldest first, because that is what
 * anybody chasing a balance means by "clear the oldest" and because it makes a part-settled bill
 * the newest one rather than an arbitrary one.
 *
 * The allocation is worked out here and then **stored**: it is a decision made at one instant
 * against the bills open at that instant, and re-deriving it a week later against a different
 * set of open bills would answer differently.
 */

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** One bill a party still owes something on, oldest first by `at`. `owed` is the bill's own
 *  total less whatever earlier settlements already closed off it. */
export interface OpenBill { no: string; at: string; owed: number }
export interface SettlementAllocation {
  lines: { no: string; amount: number }[];
  /** What the payment could not be put anywhere. The service refuses a payment that leaves any,
   *  so this is only ever non-zero on the way to that refusal. */
  left: number;
}

/**
 * Walk the open bills oldest first and lay `amount` over them.
 *
 * A bill is only ever partly settled when the money ran out part-way through it, so at most one
 * line here is a part payment and it is always the last. Rounding is to the paisa on each line,
 * and the remainder carries forward rather than being recomputed, so the lines always add back
 * up to what was allocated.
 */
export function allocateSettlement(open: readonly OpenBill[], amount: number): SettlementAllocation {
  const lines: { no: string; amount: number }[] = [];
  let left = round2(amount);
  for (const b of [...open].sort((a, c) => a.at.localeCompare(c.at))) {
    if (left <= 0) break;
    const owed = round2(b.owed);
    if (owed <= 0) continue;
    const put = round2(Math.min(owed, left));
    lines.push({ no: b.no, amount: put });
    left = round2(left - put);
  }
  return { lines, left };
}

/** Refused rather than parked: a hospital canteen has no use for a credit balance, and a
 *  payment bigger than the debt is a typed figure nobody meant. Says what is actually owed, so
 *  the person at the screen can correct it without going to look. */
export const settlementOverpayMessage = (amount: number, outstanding: number, payerName: string): string =>
  `Refused - ${money(amount)} is more than the ${money(outstanding)} ${payerName} still owes`;

/** And the other end of it: there is nothing to settle at all. */
export const nothingOwedMessage = (payerName: string): string =>
  `Refused - ${payerName} owes nothing`;
