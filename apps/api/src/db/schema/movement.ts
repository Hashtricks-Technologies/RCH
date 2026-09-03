import { boolean, char, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { reqStatusEnum, shopAskStatusEnum, ticketRefEnum, ticketStatusEnum } from "./enums.js";
import { items, locations, qty, ts, users } from "./master.js";

export const stockRequests = pgTable("stock_requests", {
  id: text("id").primaryKey(),
  fromLoc: text("from_loc").notNull().references(() => locations.key),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  status: reqStatusEnum("status").notNull(),
  ticketId: text("ticket_id"),
  managerNote: text("manager_note").notNull().default(""),
  urgent: boolean("urgent").notNull().default(false),
  approvedBy: text("approved_by").references(() => users.id),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("stock_requests_status_idx").on(t.status), index("stock_requests_from_idx").on(t.fromLoc)]);

export const stockRequestLines = pgTable("stock_request_lines", {
  requestId: text("request_id").notNull().references(() => stockRequests.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  approvedQty: qty("approved_qty").notNull().default(0),
  shortQty: qty("short_qty"),
}, (t) => [primaryKey({ columns: [t.requestId, t.lineNo] })]);

export const tickets = pgTable("tickets", {
  id: text("id").primaryKey(),
  refType: ticketRefEnum("ref_type").notNull(),
  refId: text("ref_id").notNull(),        // request id, prod order id, shop ask id, or the label "Direct issue"/"Shop transfer"
  fromLoc: text("from_loc").notNull().references(() => locations.key),
  toLoc: text("to_loc").notNull().references(() => locations.key),
  status: ticketStatusEnum("status").notNull(),
  otp: char("otp", { length: 6 }).notNull(),
  issuedBy: text("issued_by").references(() => users.id),
  issuedAt: ts("issued_at").notNull().defaultNow(),
  collectedAt: ts("collected_at"),
  receivedAt: ts("received_at"),
}, (t) => [index("tickets_status_idx").on(t.status), index("tickets_to_idx").on(t.toLoc)]);

export const ticketLines = pgTable("ticket_lines", {
  ticketId: text("ticket_id").notNull().references(() => tickets.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
}, (t) => [primaryKey({ columns: [t.ticketId, t.lineNo] })]);

export const shopAsks = pgTable("shop_asks", {
  id: text("id").primaryKey(),
  fromLoc: text("from_loc").notNull().references(() => locations.key),
  toLoc: text("to_loc").notNull().references(() => locations.key),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  status: shopAskStatusEnum("status").notNull(),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  note: text("note").notNull().default(""),
  grantedQty: qty("granted_qty"),
  ticketId: text("ticket_id").references(() => tickets.id),
  reason: text("reason"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
