import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, primaryKey, smallint, text } from "drizzle-orm/pg-core";
import { adjReqStatusEnum, adjustReasonEnum } from "./enums.js";
import { items, locations, money, qty, ts, users } from "./master.js";

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

/**
 * A counter's ask to correct its own shelf, before the outlet manager has decided it. `loc` is a
 * plain location key, not `StockLoc` the way `adjustments.loc` is: a counter works one of the
 * three outlets, never quarantine and never the central store or kitchen, so there is no sixth
 * shelf to name here.
 *
 * `adjustmentId` is set once, on approval - the `ADJ-` document the request became, written by
 * the same `writeAdjustment` the store keeper's and the kitchen's own screens call. Nothing here
 * reserves anything: an adjustment has no hand-off to scan, so approving one is the whole of the
 * movement rather than the first half of it.
 */
export const adjustmentRequests = pgTable("adjustment_requests", {
  id: text("id").primaryKey(),
  loc: text("loc").notNull().references(() => locations.key),
  reason: adjustReasonEnum("reason").notNull(),
  note: text("note").notNull().default(""),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  status: adjReqStatusEnum("status").notNull(),
  approvedBy: text("approved_by").references(() => users.id),
  adjustmentId: text("adjustment_id").references(() => adjustments.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("adjustment_requests_status_idx").on(t.status),
  index("adjustment_requests_loc_idx").on(t.loc),
]);

/** Signed, exactly like `adjustmentLines`: the sign the counter picked survives untouched from
 *  the ask through to the document the manager's approval writes. */
export const adjustmentRequestLines = pgTable("adjustment_request_lines", {
  requestId: text("request_id").notNull().references(() => adjustmentRequests.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
}, (t) => [primaryKey({ columns: [t.requestId, t.lineNo] })]);

/**
 * Kitchen wastage: a loss recorded against a raw or packing line the kitchen holds no stock of.
 *
 * What lands at the kitchen is used the moment it lands (`usedOnArrival`, @rch/domain), so a
 * spoiled sack of maida has no shelf to come off - an `ADJ-` document would be a write-off of
 * nothing, refused as more than is free. This is the record instead: one item, how much, why,
 * and what it was worth at the standard cost of the day. It posts no move and reads no balance.
 * `cost` and `value` are stored so a cost moved next month leaves this month's loss as it was.
 */
export const wastage = pgTable("wastage", {
  id: text("id").primaryKey(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  reason: adjustReasonEnum("reason").notNull(),
  note: text("note").notNull().default(""),
  cost: money("cost").notNull(),
  value: money("value").notNull(),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
}, (t) => [
  index("wastage_at_idx").on(t.at),
  check("wastage_qty_ck", sql`${t.qty} > 0`),
  // A count and a return to the vendor are corrections to a shelf; the kitchen has none here.
  check("wastage_reason_ck", sql`${t.reason} in ('wastage', 'breakage', 'expired', 'other')`),
]);
