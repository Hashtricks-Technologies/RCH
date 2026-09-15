import { pgEnum } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["counter", "manager", "store", "prod", "buyer"]);
export const locationTypeEnum = pgEnum("location_type", ["Store", "Kitchen", "Outlet"]);
export const itemTypeEnum = pgEnum("item_type", ["RAW", "PACK", "MRP", "FG", "MTO"]);
/** Which desk a counter's stock request for an item is auto-routed to. Nullable on the row - an
 *  item with none falls back to its type (`sourceOf`, `@rch/domain`). */
export const sourceEnum = pgEnum("source", ["store", "kitchen"]);
export const moveKindEnum = pgEnum("move_kind", [
  "opening", "sale", "ticket_out", "ticket_in", "production_consume", "production_yield",
  "grn_accept", "grn_reject", "adjustment", "reversal",
]);
export const reqStatusEnum = pgEnum("req_status", [
  "Draft", "Request sent", "Manager approved", "Partially approved", "Ticket issued",
  "Collected", "Received", "Closed", "Rejected", "Cancelled",
]);
export const ticketStatusEnum = pgEnum("ticket_status", ["Issued", "Collected", "Received", "Cancelled"]);
export const ticketRefEnum = pgEnum("ticket_ref", ["request", "prod_order", "direct", "shop_transfer", "shop_ask"]);
export const shopAskStatusEnum = pgEnum("shop_ask_status", ["Asked", "Sent", "Declined"]);
export const prodOrderStatusEnum = pgEnum("prod_order_status", ["New", "Accepted", "In kitchen", "Ready", "Dispatched", "Declined"]);
export const prqStatusEnum = pgEnum("prq_status", ["Sent", "Approved", "Partially approved", "Declined"]);
export const poStatusEnum = pgEnum("po_status", ["Draft", "Ordered", "Partially received", "Received", "Cancelled"]);
export const payerKindEnum = pgEnum("payer_kind", ["patient", "staff", "dept"]);
export const supportTopicEnum = pgEnum("support_topic", [
  "Sign in & access", "A screen will not load", "A number looks wrong", "Printing & receipts",
  "Slow or freezing", "Training & how do I", "Feature request", "Something else",
]);
export const supportPriorityEnum = pgEnum("support_priority", ["Low", "Normal", "Urgent"]);
export const supportStatusEnum = pgEnum("support_status", ["Open", "With support", "Waiting on you", "Resolved", "Closed"]);
export const messageFromEnum = pgEnum("message_from", ["user", "support"]);
export const productReqStatusEnum = pgEnum("product_req_status", ["Requested", "Created", "Declined"]);
// ---- adjustments. Why a shelf was corrected, as a closed set: the reason is what a month-end
// query groups by, and free text would make three answers out of one question. `count` is the
// physical count - a correction to a sum, not a loss.
export const adjustReasonEnum = pgEnum("adjust_reason", ["wastage", "breakage", "expired", "count", "returned_to_vendor", "other"]);
// ---- adjustment requests. There is no "Ticket issued" stage here the way a stock request has
// one: approving one both decides it and writes the correction in the same step, so "Approved"
// is the end of the line rather than a hand-off to something else.
export const adjReqStatusEnum = pgEnum("adj_req_status", ["Request sent", "Approved", "Rejected", "Cancelled"]);
