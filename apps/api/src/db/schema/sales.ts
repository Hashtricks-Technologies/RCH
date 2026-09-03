import { index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { payerKindEnum } from "./enums.js";
import { items, locations, money, qty, ts, users } from "./master.js";

export const bills = pgTable("bills", {
  no: text("no").primaryKey(),
  loc: text("loc").notNull().references(() => locations.key),
  operatorId: text("operator_id").notNull().references(() => users.id),
  total: money("total").notNull(),
  tax: money("tax").notNull(),
  at: ts("at").notNull().defaultNow(),
  tender: text("tender").notNull(),
  payerKind: payerKindEnum("payer_kind"),
  payerId: text("payer_id"),
  payerName: text("payer_name"),
}, (t) => [index("bills_loc_at_idx").on(t.loc, t.at)]);
export const billLines = pgTable("bill_lines", {
  billNo: text("bill_no").notNull().references(() => bills.no),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  rate: money("rate").notNull(),
}, (t) => [primaryKey({ columns: [t.billNo, t.lineNo] })]);
