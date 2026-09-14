import { index, pgTable, primaryKey, smallint, text } from "drizzle-orm/pg-core";
import { adjustReasonEnum } from "./enums.js";
import { items, locations, qty, ts, users } from "./master.js";

/**
 * A write-off or a count-up, as a document.
 *
 * Before this there was none: wastage, breakage, an expiry disposal, a physical-count
 * correction and a return out of the rejected-goods shelf were all hand-written SQL, which
 * leaves the books balanced and the reason nowhere. `move_kind` has carried `'adjustment'`
 * since the first migration with nothing writing it.
 *
 * `loc` references `locations.key`, which includes the rejected-goods shelf - the one place
 * stock is reported that no operator works at, and the one shelf nothing else can take stock
 * off again. The reason is an enum, not free text: it is what a month-end query groups by, and
 * "spoilt", "spoiled" and "Spoilt" would be three answers to one question.
 */
export const adjustments = pgTable("adjustments", {
  id: text("id").primaryKey(),
  loc: text("loc").notNull().references(() => locations.key),
  reason: adjustReasonEnum("reason").notNull(),
  note: text("note").notNull().default(""),
  byUser: text("by_user").references(() => users.id),
  at: ts("at").notNull().defaultNow(),
}, (t) => [
  // Both readers ask the same question: one shelf over a window - the register the store keeper
  // reads back, and the month-end "what did this location lose, and why".
  index("adjustments_loc_at_idx").on(t.loc, t.at),
]);

/** Signed, like the moves behind them: negative wrote stock off, positive counted it up. The
 *  service folds a repeated item into one line and drops what folds to zero before anything is
 *  written, so one line here is exactly one `adjustment` move on the ledger. */
export const adjustmentLines = pgTable("adjustment_lines", {
  adjustmentId: text("adjustment_id").notNull().references(() => adjustments.id),
  lineNo: smallint("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
}, (t) => [primaryKey({ columns: [t.adjustmentId, t.lineNo] })]);
