import { boolean, check, index, integer, pgTable, primaryKey, smallint, text, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { qrModeEnum, qrOrderStatusEnum, refundReasonEnum, refundStatusEnum } from "./enums.js";
import { items, locations, money, qty, ts, users } from "./master.js";
import { bills } from "./sales.js";

/**
 * QR ordering: a customer scans a code placed at an outlet, orders from their phone, pays through
 * the gateway, and the capture raises an ordinary bill at that outlet (`lib/sale.ts`, operator the
 * system account, tender `Online`). Migration `0027_qr_orders`.
 */

/**
 * A printed code. `token` is what the poster encodes - 192 random bits, base64url - and is the
 * only thing a phone ever sends to find the code; regenerating it (`rotated_at`) makes every poster
 * already printed stop working. Switched off, never deleted: an order names the code it came from.
 */
export const qrCodes = pgTable("qr_codes", {
  id: text("id").primaryKey(),
  loc: text("loc").notNull().references(() => locations.key),
  label: text("label").notNull(),
  mode: qrModeEnum("mode").notNull(),
  token: text("token").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  rotatedAt: ts("rotated_at"),
}, (t) => [
  uniqueIndex("qr_codes_token_uq").on(t.token),
  index("qr_codes_loc_idx").on(t.loc),
]);

/**
 * One ordering window per outlet per weekday, in IST (`qrOpenAt` in @rch/domain). A weekday with
 * no row takes no QR orders, so an outlet takes none until the super admin sets its hours. The
 * times are `HH:MM` text, compared as text exactly as the domain compares them; a window never
 * crosses midnight.
 */
export const outletOrderHours = pgTable("outlet_order_hours", {
  loc: text("loc").notNull().references(() => locations.key),
  dow: smallint("dow").notNull(),
  opens: text("opens").notNull(),
  closes: text("closes").notNull(),
}, (t) => [
  primaryKey({ columns: [t.loc, t.dow] }),
  check("outlet_order_hours_dow_ck", sql`${t.dow} between 0 and 6`),
  check("outlet_order_hours_hhmm_ck", sql`${t.opens} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and ${t.closes} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check("outlet_order_hours_window_ck", sql`${t.closes} > ${t.opens}`),
]);

/** The counter's own switch. No row reads as not paused. */
export const qrOutletState = pgTable("qr_outlet_state", {
  loc: text("loc").primaryKey().references(() => locations.key),
  paused: boolean("paused").notNull().default(false),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  updatedBy: text("updated_by").references(() => users.id),
});

/**
 * An order a customer placed from a code. The lines' `rate`s, `total`, `tax` and `discount` are
 * the server's quote when it was placed (`planBill`); the capture re-prices and refunds rather
 * than bill a figure that moved. `secret_hash` is the sha256 of the secret handed to the phone
 * once; `nonce` is the phone's per-checkout id, so a double tap places one order. The status
 * trail is `document_history` (`appendHistory(tx, "qr_order", …)`).
 */
export const qrOrders = pgTable("qr_orders", {
  id: text("id").primaryKey(),
  loc: text("loc").notNull().references(() => locations.key),
  qrCodeId: text("qr_code_id").notNull().references(() => qrCodes.id),
  // The code's label and mode as they stood when the order was placed: a code renamed or
  // switched to the other mode afterwards does not change where this order goes.
  label: text("label").notNull(),
  mode: qrModeEnum("mode").notNull(),
  /** Where to bring it, on a deliver code ("Bed 12"); empty on a pickup code. */
  spot: text("spot").notNull().default(""),
  status: qrOrderStatusEnum("status").notNull().default("Awaiting payment"),
  customerName: text("customer_name").notNull(),
  /** Ten digits (`normalizePhone`). */
  customerPhone: text("customer_phone").notNull(),
  total: money("total").notNull(),
  tax: money("tax").notNull(),
  discount: money("discount").notNull().default(0),
  secretHash: text("secret_hash").notNull(),
  nonce: text("nonce").notNull(),
  /** The address the order was placed from - the per-address cap on unpaid orders counts it. */
  ip: text("ip").notNull().default(""),
  rzpOrderId: text("rzp_order_id"),
  /** The payment that was billed (or refunded as unfulfillable). A second capture of the same
   *  order is refunded as a duplicate and never lands here. */
  rzpPaymentId: text("rzp_payment_id"),
  billNo: text("bill_no").references((): AnyPgColumn => bills.no),
  expiresAt: ts("expires_at").notNull(),
  paidAt: ts("paid_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("qr_orders_nonce_uq").on(t.nonce),
  uniqueIndex("qr_orders_rzp_order_uq").on(t.rzpOrderId),
  uniqueIndex("qr_orders_rzp_payment_uq").on(t.rzpPaymentId),
  uniqueIndex("qr_orders_bill_uq").on(t.billNo),
  // The counter's queue, one outlet at a time.
  index("qr_orders_loc_status_idx").on(t.loc, t.status),
  // Unpaid orders per phone (`QR_PENDING_PER_PHONE`).
  index("qr_orders_phone_status_idx").on(t.customerPhone, t.status),
  // Unpaid orders per address in the last half hour (`QR_PENDING_PER_IP`).
  index("qr_orders_ip_created_idx").on(t.ip, t.createdAt),
  // What the worker expires.
  index("qr_orders_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'Awaiting payment'`),
]);

/** An order's lines as quoted: the price before the party's discount, as a bill line stores it. */
export const qrOrderLines = pgTable("qr_order_lines", {
  orderId: text("order_id").notNull().references(() => qrOrders.id),
  lineNo: integer("line_no").notNull(),
  itemKey: text("item_key").notNull().references(() => items.key),
  qty: qty("qty").notNull(),
  rate: money("rate").notNull(),
}, (t) => [primaryKey({ columns: [t.orderId, t.lineNo] })]);

/**
 * Money going back to a customer, sent to the gateway by the worker. `lib/refunds.ts` is the only
 * writer (`scripts/check-boundaries.sh`). The id is the order's own followed by `-R<n>`, so a
 * refund reads as belonging to its order and the gateway's `notes.rid` names it without a lookup.
 * `rzp_refund_id` is set once the gateway has accepted it; the worker looks a refund up by its
 * `notes.rid` before sending again, so a retry never refunds twice.
 */
export const paymentRefunds = pgTable("payment_refunds", {
  id: text("id").primaryKey(),
  qrOrderId: text("qr_order_id").notNull().references(() => qrOrders.id),
  /** The bill a void refunds; null for a capture that was never billed. */
  billNo: text("bill_no").references(() => bills.no),
  paymentId: text("payment_id").notNull(),
  amount: money("amount").notNull(),
  reason: refundReasonEnum("reason").notNull(),
  status: refundStatusEnum("status").notNull().default("Pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  lastError: text("last_error"),
  rzpRefundId: text("rzp_refund_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
}, (t) => [
  check("payment_refunds_amount_ck", sql`${t.amount} > 0`),
  uniqueIndex("payment_refunds_rzp_refund_uq").on(t.rzpRefundId),
  index("payment_refunds_order_idx").on(t.qrOrderId),
  // What the worker sends next.
  index("payment_refunds_due_idx").on(t.status, t.nextAttemptAt),
]);

/** Every webhook delivery the gateway made, by its event id, so a repeated delivery is dropped. */
export const rzpWebhookEvents = pgTable("rzp_webhook_events", {
  eventId: text("event_id").primaryKey(),
  event: text("event").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
});
