import { check, date, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { prodOrderStatusEnum } from "./enums.js";
import { items, locations, qty, ts, users } from "./master.js";

export const prodOrders = pgTable("prod_orders", {
  id: text("id").primaryKey(),
  fromLoc: text("from_loc").notNull().references(() => locations.key),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  status: prodOrderStatusEnum("status").notNull(),
  // ---- prod-order raise ---- when the outlet needs it by. Nullable, because most orders carry
  // no date at all and a defaulted one would read as a deadline nobody set.
  needBy: date("need_by"),
  note: text("note").notNull().default(""),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export const prodOrderLines = pgTable("prod_order_lines", {
  orderId: text("order_id").notNull().references(() => prodOrders.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
}, (t) => [primaryKey({ columns: [t.orderId, t.lineNo] })]);
export const batches = pgTable("batches", {
  id: text("id").primaryKey(),
  itemKey: text("item_key").notNull().references(() => items.key),
  startedQty: qty("started_qty").notNull(),
  madeQty: qty("made_qty").notNull(),
  at: ts("at").notNull().defaultNow(),
  bestBefore: ts("best_before").notNull(),
  note: text("note"),
  byUser: text("by_user").references(() => users.id),
}, (t) => [
  // A batch yields some of what it started and never more: the ingredients went against what
  // was started, so a yield above it would be stock nothing was ever consumed for.
  check("batches_made_ck", sql`${t.madeQty} >= 0 and ${t.madeQty} <= ${t.startedQty}`),
]);
