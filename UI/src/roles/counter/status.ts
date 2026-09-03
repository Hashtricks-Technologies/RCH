import type { Tone } from "../../types";

/** How a bill reads on the counter's own list, derived from the tender it was settled with. */
export const billStatus = (pay: string): { label: string; tone: Tone } => {
  if (pay === "Patient bill") return { label: "Posted to IP", tone: "in" };
  if (pay === "Staff credit") return { label: "On credit", tone: "wn" };
  if (pay === "Dept") return { label: "Dept charge", tone: "ac" };
  return { label: "Paid", tone: "ok" };
};

/**
 * Where the money for a bill actually ends up. Three places, not two:
 *  - `drawer`  cash notes the operator physically holds and hands over at shift end
 *  - `bank`    card and UPI — taken at the till, but settled to the hospital account
 *  - `account` patient, staff and department bills — billed value, nothing was collected
 * Only `drawer` may be added to the opening float; the other two are billed, not banked
 * in the till, and mixing them is what makes a shift's cash figure read wrong.
 */
export type Settlement = "drawer" | "bank" | "account";
const CHARGED = ["Patient bill", "Staff credit", "Dept"];
export const settlementOf = (pay: string): Settlement =>
  pay === "Cash" ? "drawer" : CHARGED.includes(pay) ? "account" : "bank";

export const SETTLEMENT_LABEL: Record<Settlement, string> = {
  drawer: "Cash in drawer",
  bank: "Card & UPI",
  account: "Charged to an account",
};
