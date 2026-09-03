import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { prodOrderStatusEnum } from "./enums.js";
import { items, locations, qty, ts, users } from "./master.js";

export const prodOrders = pgTable("prod_orders", {
  id: text("id").primaryKey(),
  fromLoc: text("from_loc").notNull().references(() => locations.key),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  status: prodOrderStatusEnum("status").notNull(),
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
});
