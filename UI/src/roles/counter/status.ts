import { istDate } from "@rch/domain";
import type { BillRow, Tone } from "../../types";

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

// ---- bill void ----
/** The hospital's own calendar day a bill belongs to, or `""` when the row carries no instant
 *  to read it off — the fixtures the suites seed from hold display strings, not instants. */
export const billDay = (b: BillRow): string => (b.iso ? istDate(new Date(b.iso)) : "");

/** Whether the manager's Void button belongs on this bill. A preview of the server's rule and
 *  never the decision (`POST /bills/:no/void` refuses on its own read): same hospital day, not
 *  already voided, and a row whose day cannot be told offers nothing rather than guessing. */
export const voidableToday = (b: BillRow, now: Date = new Date()): boolean =>
  !b.voided && billDay(b) !== "" && billDay(b) === istDate(now);
