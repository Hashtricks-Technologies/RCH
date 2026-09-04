import { money } from "./format.js";
import { fq } from "./availability.js";
import { round3 } from "./round.js";

/**
 * What a store keeper may book in, and what they may not.
 *
 * Nothing enters stock without a batch behind it, and no batch is accepted that is already
 * expired or mis-dated. Every sentence here is the browser's own, character for character, and
 * so is their order: the same delivery must produce the same refusal whichever side checks it.
 */
/** Vendors over-deliver by a packet or two; more than this is a purchase decision, not a receipt. */
export const RECEIPT_TOLERANCE = 1.02;

export type ReceiptCheckLine = {
  name: string; unit: string;
  /** What the order asked for, and what earlier instalments already booked in. */
  ordered: number; received: number;
  /** The item's own printed MRP, or null when it does not carry one, and its list-A shelf price. */
  mrp: number | null; listA: number;
};
export type ReceiptCheckInput = { recv: number; rejected: number; batch: string; mrp: number; mfg: string; exp: string };

/**
 * The refusal this line earns, or null. `today` is an `IsoDate` in the hospital's calendar
 * (`istDate`), and both date comparisons are string comparisons on `YYYY-MM-DD` — which is
 * exactly right for a date with no time in it, and avoids the trap the browser had to work
 * around, where a bare date parses as UTC midnight and a "today" built from the host's clock
 * sits behind it in every zone west of UTC.
 */
export function checkReceiptLine(l: ReceiptCheckLine, r: ReceiptCheckInput, today: string): string | null {
  const total = round3(l.received + r.recv);
  if (total > round3(l.ordered * RECEIPT_TOLERANCE)) {
    return `${l.name} — ${fq(total, l.unit)} exceeds the ordered ${fq(l.ordered, l.unit)} by more than 2%; hold it for purchase approval`;
  }
  if (r.rejected < 0 || r.rejected > r.recv) return `${l.name} — rejected quantity cannot exceed what arrived`;
  if (!r.batch.trim()) return `${l.name} needs its batch or lot number`;
  if (!r.mfg || !r.exp) return `${l.name} needs a manufacturing and an expiry date`;
  if (r.exp <= r.mfg) return `${l.name} — expiry cannot fall on or before the manufacturing date`;
  if (r.exp < today) return `${l.name} — batch ${r.batch.trim()} has already expired; do not book it in`;
  if (l.mrp != null && r.mrp > 0 && r.mrp < l.listA) {
    return `${l.name} — printed MRP ${money(r.mrp)} is below the shelf price; reprice before selling`;
  }
  return null;
}

/** Where the order stands once an instalment is booked: covered on every line, or not yet. */
export const receiptStatus = (lines: readonly { qty: number; recv: number }[]): "Received" | "Partially received" =>
  lines.every((l) => l.recv >= l.qty) ? "Received" : "Partially received";
