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
  /**
   * What the order asked for, and what earlier instalments **accepted** - arrival less whatever
   * quality control turned away, `netReceived` below. A rejected quantity went to quarantine
   * rather than onto the shelf, so the vendor still owes it: counting it here would refuse the
   * replacement delivery that settles the line, which is the one delivery that has to get in.
   */
  ordered: number; received: number;
  /** The item's own printed MRP, or null when it does not carry one, and its list-A shelf price. */
  mrp: number | null; listA: number;
};
export type ReceiptCheckInput = { recv: number; rejected: number; batch: string; mrp: number; mfg: string; exp: string };

/**
 * The MRP floor, on its own: a printed MRP under the shelf price is stock that cannot be sold
 * at the price it is listed at, and the store keeper has to hear so before it goes on the rack.
 *
 * Extracted from `checkReceiptLine` because a second door now asks the same question - the item
 * master's own `PATCH /items/:it`, where the manager may move an item's MRP down past a price
 * list instead of a delivery arriving with a lower number printed on it. Both refusals are the
 * same fact about the same item, so they are the same sentence, produced once. `listPrice` is
 * the highest list the item is on: a ceiling that clears list A but not list B is still a
 * ceiling one counter cannot sell under.
 */
export const mrpBelowShelfPrice = (name: string, mrp: number, listPrice: number): string | null =>
  mrp < listPrice ? `${name} - printed MRP ${money(mrp)} is below the shelf price; reprice before selling` : null;

/**
 * The refusal this line earns, or null. `today` is an `IsoDate` in the hospital's calendar
 * (`istDate`), and both date comparisons are string comparisons on `YYYY-MM-DD` - which is
 * exactly right for a date with no time in it, and avoids the trap the browser had to work
 * around, where a bare date parses as UTC midnight and a "today" built from the host's clock
 * sits behind it in every zone west of UTC.
 */
export function checkReceiptLine(l: ReceiptCheckLine, r: ReceiptCheckInput, today: string): string | null {
  const total = round3(l.received + r.recv);
  if (total > round3(l.ordered * RECEIPT_TOLERANCE)) {
    return `${l.name} - ${fq(total, l.unit)} exceeds the ordered ${fq(l.ordered, l.unit)} by more than 2%; hold it for purchase approval`;
  }
  if (r.rejected < 0 || r.rejected > r.recv) return `${l.name} - rejected quantity cannot exceed what arrived`;
  if (!r.batch.trim()) return `${l.name} needs its batch or lot number`;
  if (!r.mfg || !r.exp) return `${l.name} needs a manufacturing and an expiry date`;
  if (r.exp <= r.mfg) return `${l.name} - expiry cannot fall on or before the manufacturing date`;
  if (r.exp < today) return `${l.name} - batch ${r.batch.trim()} has already expired; do not book it in`;
  if (l.mrp != null && r.mrp > 0) return mrpBelowShelfPrice(l.name, r.mrp, l.listA);
  return null;
}

/**
 * What a purchase-order line has actually taken in: what arrived, less what quality control
 * turned away.
 *
 * `po_lines.received_qty` stays the arrival record - it is what the delivery notes add up to -
 * and `rejected_qty` the running total sent to quarantine. Every question about whether the
 * vendor has *delivered* is asked of the difference, through here, so a rejection is owed again
 * rather than quietly written off the order.
 */
export const netReceived = (l: { recv: number; rejected: number }): number => round3(l.recv - l.rejected);

/**
 * Where the order stands once an instalment is booked: covered on every line, or not yet.
 *
 * Covered means **accepted**, not arrived. Stock turned away at the door never entered the
 * hospital, so an order cannot reach `Received` - which is terminal, and closes both the
 * close-short and the cancel door behind it - on the strength of a consignment that was sent
 * straight back.
 */
export const receiptStatus = (lines: readonly { qty: number; recv: number; rejected: number }[]): "Received" | "Partially received" =>
  lines.every((l) => netReceived(l) >= l.qty) ? "Received" : "Partially received";
