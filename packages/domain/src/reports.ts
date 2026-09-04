import { round3 } from "./round.js";

/** One item's line of a location's stock ledger over a window. */
export interface LedgerRow { it: string; opening: number; recd: number; issued: number; closing: number }

/**
 * The ledger's one piece of arithmetic, written once because the server computes it and the
 * browser prints it (spec §5.1).
 *
 * `before` is the sum of every signed move at this location before the window opened — the true
 * opening balance, not a figure worked backwards from today's closing through receipts and
 * issues, which is what the browser had to do when it held no moves and what a cancelled ticket
 * or an adjustment quietly broke. `inWindow` is the window's signed moves: positive is received,
 * negative is issued, and there is no third kind because the ledger has none.
 */
export const ledgerRow = (it: string, before: number, inWindow: readonly number[]): LedgerRow => {
  const recd = round3(inWindow.reduce((t, q) => (q > 0 ? t + q : t), 0));
  const issued = round3(inWindow.reduce((t, q) => (q < 0 ? t - q : t), 0));
  const opening = round3(before);
  return { it, opening, recd, issued, closing: round3(opening + recd - issued) };
};

/** The column totals a report foot prints. */
export const ledgerTotals = (rows: readonly LedgerRow[]): Omit<LedgerRow, "it"> => ({
  opening: round3(rows.reduce((t, r) => t + r.opening, 0)),
  recd: round3(rows.reduce((t, r) => t + r.recd, 0)),
  issued: round3(rows.reduce((t, r) => t + r.issued, 0)),
  closing: round3(rows.reduce((t, r) => t + r.closing, 0)),
});
