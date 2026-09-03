import { boolean, date, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { poStatusEnum, prqStatusEnum } from "./enums.js";
import { items, money, qty, ts, users, vendors } from "./master.js";

export const requisitions = pgTable("requisitions", {
  id: text("id").primaryKey(),
  byUser: text("by_user").notNull().references(() => users.id),
  at: ts("at").notNull().defaultNow(),
  status: prqStatusEnum("status").notNull(),
  note: text("note").notNull().default(""),
  approvedBy: text("approved_by").references(() => users.id),
  approvalNote: text("approval_note"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export const requisitionLines = pgTable("requisition_lines", {
  requisitionId: text("requisition_id").notNull().references(() => requisitions.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  approvedQty: qty("approved_qty").notNull().default(0),
  orderedQty: qty("ordered_qty").notNull().default(0),
  shortQty: qty("short_qty"),
}, (t) => [primaryKey({ columns: [t.requisitionId, t.lineNo] })]);

export const purchaseOrders = pgTable("purchase_orders", {
  id: text("id").primaryKey(),
  vendorId: text("vendor_id").notNull().references(() => vendors.id),
  at: ts("at").notNull().defaultNow(),
  status: poStatusEnum("status").notNull(),
  eta: date("eta"),
  needsApproval: boolean("needs_approval").notNull().default(false),
  shortNote: text("short_note"),
  receivedAt: ts("received_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("purchase_orders_status_idx").on(t.status)]);
export const poLines = pgTable("po_lines", {
  poId: text("po_id").notNull().references(() => purchaseOrders.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  rate: money("rate").notNull(),
  receivedQty: qty("received_qty").notNull().default(0),
  rejectedQty: qty("rejected_qty").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.poId, t.lineNo] })]);
export const poLineSources = pgTable("po_line_sources", {
  poId: text("po_id").notNull().references(() => purchaseOrders.id),
  lineNo: integer("line_no").notNull(),
  seq: integer("seq").notNull(),
  requisitionId: text("requisition_id").notNull().references(() => requisitions.id),
  requisitionLineNo: integer("requisition_line_no").notNull(),
  qty: qty("qty").notNull(),
}, (t) => [primaryKey({ columns: [t.poId, t.lineNo, t.seq] })]);

export const grns = pgTable("grns", {
  id: text("id").primaryKey(),
  poId: text("po_id").notNull().references(() => purchaseOrders.id),
  poLineNo: integer("po_line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  acceptedQty: qty("accepted_qty").notNull(),
  rejectedQty: qty("rejected_qty").notNull().default(0),
  batchNo: text("batch_no").notNull(),
  mrp: money("mrp").notNull().default(0),
  mfg: date("mfg").notNull(),
  exp: date("exp").notNull(),
  dcNo: text("dc_no").notNull(),
  invoiceNo: text("invoice_no").notNull().default(""),
  invoiceDate: date("invoice_date"),
  at: ts("at").notNull().defaultNow(),
  byUser: text("by_user").references(() => users.id),
}, (t) => [index("grns_po_idx").on(t.poId)]);
