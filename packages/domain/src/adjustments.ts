import type { AdjustReason } from "@rch/contract";

/**
 * How each reason for correcting a shelf is written out.
 *
 * The wire carries the enum - one answer per reason, so a month-end query can group by it -
 * and this is the one place it becomes words. Both sides read it: the server signs an
 * adjustment's `document_history` row with it, and the browser's picker and register print it.
 * A second copy on either side is how a trail and a screen end up disagreeing about what
 * happened to the same document.
 */
export const REASON_LABEL: Readonly<Record<AdjustReason, string>> = {
  wastage: "Wastage",
  breakage: "Breakage",
  expired: "Expired",
  count: "Stock count",
  returned_to_vendor: "Returned to vendor",
  other: "Other",
};
