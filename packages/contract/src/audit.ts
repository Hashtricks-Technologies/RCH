import type { AnyRoute, RouteName, routes } from "./routes.js";
import type { AuditGroup, AuditOutcome } from "./schemas/audit.js";

/** The Audit log's areas, as the filter prints them. */
export const AUDIT_GROUPS: Record<AuditGroup, string> = {
  sales: "Sales", stock: "Stock movement", purchasing: "Purchasing", production: "Production",
  master: "Master data", accounts: "Accounts & sign-in", support: "Support",
};

// `defineRoute` keeps `method`, `write` and `service` as literals, so write-ness is readable off
// the manifest's own type: `write` when the entry says, else anything but a GET - the same
// reading as `isWriteRoute`. The auth routes say `write: false` and fall out here; sign-in,
// sign-out and a password change come back in below as actions of their own.
type WriteFlag<T extends AnyRoute> = Exclude<T["write"], undefined>;
type IsWrite<T extends AnyRoute> = [WriteFlag<T>] extends [never] ? (T["method"] extends "GET" ? false : true) : WriteFlag<T>;
type IsAudit<T extends AnyRoute> = T["service"] extends "audit" ? true : false;
/** Every manifest write the API answers. */
export type WriteRouteName = {
  [K in RouteName]: IsAudit<(typeof routes)[K]> extends true ? never : IsWrite<(typeof routes)[K]> extends true ? K : never;
}[RouteName];

/** Every manifest route that is a write (method !== "GET" unless `write` says otherwise, `write: false` excluded), plus the three auth events. */
export type AuditAction = WriteRouteName | "login" | "logout" | "changePassword";
export type AuditLabel = { label: string; refused?: string; group: AuditGroup };

/**
 * What the Audit log prints for each action, in the past tense of the person who did it.
 * `Record<AuditAction, …>` makes this exhaustive: a new write route with no line here fails
 * typecheck, and `audit.test.ts` checks the same thing against the manifest at runtime.
 * `refused` replaces the label only where a refusal means something else entirely - a refused
 * sign-in is not "Signed in" with a red pill, it is a failed sign-in.
 */
export const AUDIT_LABELS: Record<AuditAction, AuditLabel> = {
  // ---- accounts & sign-in
  login:                  { label: "Signed in", refused: "Failed sign-in", group: "accounts" },
  logout:                 { label: "Signed out", group: "accounts" },
  changePassword:         { label: "Changed their password", group: "accounts" },
  patchMe:                { label: "Changed their own details", group: "accounts" },
  createAdminUser:        { label: "Created a staff account", group: "accounts" },
  resetAdminUserPassword: { label: "Reset a staff account's password", group: "accounts" },
  deactivateAdminUser:    { label: "Deactivated a staff account", group: "accounts" },
  reactivateAdminUser:    { label: "Reactivated a staff account", group: "accounts" },
  updateAdminUser:        { label: "Changed a staff account's role and location", group: "accounts" },
  deleteAdminUser:        { label: "Deleted a staff account", group: "accounts" },
  // ---- sales
  pay:                    { label: "Posted a bill", group: "sales" },
  voidBill:               { label: "Voided a bill", group: "sales" },
  toggleAvail:            { label: "Switched an item's availability", group: "sales" },
  recordSettlement:       { label: "Recorded a settlement", group: "sales" },
  voidSettlement:         { label: "Voided a settlement", group: "sales" },
  // ---- stock movement
  createRequest:          { label: "Raised a stock request", group: "stock" },
  cancelRequest:          { label: "Cancelled a stock request", group: "stock" },
  approveRequest:         { label: "Approved a stock request", group: "stock" },
  rejectRequest:          { label: "Rejected a stock request", group: "stock" },
  redirectRequest:        { label: "Redirected a stock request to another outlet", group: "stock" },
  issueTicket:            { label: "Issued a ticket for a stock request", group: "stock" },
  handover:               { label: "Handed over a ticket", group: "stock" },
  receiveTicket:          { label: "Received a ticket", group: "stock" },
  cancelTicket:           { label: "Cancelled a ticket", group: "stock" },
  transfer:               { label: "Transferred stock to another outlet", group: "stock" },
  askShop:                { label: "Asked another outlet for stock", group: "stock" },
  answerShopAsk:          { label: "Sent stock for another outlet's ask", group: "stock" },
  declineShopAsk:         { label: "Declined another outlet's ask", group: "stock" },
  createAdjustment:       { label: "Posted a stock adjustment", group: "stock" },
  createAdjustmentRequest:  { label: "Raised an adjustment request", group: "stock" },
  cancelAdjustmentRequest:  { label: "Cancelled an adjustment request", group: "stock" },
  approveAdjustmentRequest: { label: "Approved an adjustment request", group: "stock" },
  rejectAdjustmentRequest:  { label: "Rejected an adjustment request", group: "stock" },
  // ---- production
  createProdOrder:        { label: "Raised a kitchen order", group: "production" },
  setOrderStatus:         { label: "Moved a kitchen order", group: "production" },
  dispatchProdOrder:      { label: "Dispatched a kitchen order", group: "production" },
  distribute:             { label: "Sent kitchen stock to an outlet", group: "production" },
  makeBatch:              { label: "Made a batch", group: "production" },
  // ---- purchasing
  createRequisition:      { label: "Raised a purchase requisition", group: "purchasing" },
  approveRequisition:     { label: "Approved a purchase requisition", group: "purchasing" },
  declineRequisition:     { label: "Declined a purchase requisition", group: "purchasing" },
  addToProcurementList:   { label: "Added to the procurement list", group: "purchasing" },
  createPo:               { label: "Raised a purchase order", group: "purchasing" },
  updatePoLine:           { label: "Changed a purchase order line", group: "purchasing" },
  removePoLine:           { label: "Removed a purchase order line", group: "purchasing" },
  patchPo:                { label: "Changed a purchase order", group: "purchasing" },
  sendPo:                 { label: "Sent a purchase order", group: "purchasing" },
  cancelPo:               { label: "Cancelled a purchase order", group: "purchasing" },
  receivePo:              { label: "Received goods against a purchase order", group: "purchasing" },
  closePoShort:           { label: "Closed a purchase order short", group: "purchasing" },
  // ---- master data
  createItem:             { label: "Added a product", group: "master" },
  patchItem:              { label: "Changed a product", group: "master" },
  setItemImage:           { label: "Set a product's photo", group: "master" },
  removeItemImage:        { label: "Removed a product's photo", group: "master" },
  savePrice:              { label: "Changed a price", group: "master" },
  createPriceList:        { label: "Created a price list", group: "master" },
  deletePriceList:        { label: "Deleted a price list", group: "master" },
  setOutletPriceList:     { label: "Switched an outlet's price list", group: "master" },
  addMenuItem:            { label: "Added an item to a menu", group: "master" },
  removeMenuItem:         { label: "Removed an item from a menu", group: "master" },
  addVendor:              { label: "Added a vendor", group: "master" },
  updateVendor:           { label: "Changed a vendor", group: "master" },
  addContract:            { label: "Added a rate contract", group: "master" },
  updateContract:         { label: "Changed a rate contract", group: "master" },
  removeContract:         { label: "Removed a rate contract", group: "master" },
  createProductRequest:   { label: "Asked for a new product", group: "master" },
  answerProductRequest:   { label: "Answered a new-product request", group: "master" },
  createOutlet:           { label: "Opened an outlet", group: "master" },
  updateOutlet:           { label: "Changed an outlet", group: "master" },
  closeOutlet:            { label: "Closed an outlet", group: "master" },
  reopenOutlet:           { label: "Reopened an outlet", group: "master" },
  createPayer:            { label: "Added a payer", group: "master" },
  updatePayer:            { label: "Changed a payer", group: "master" },
  setClassTerms:          { label: "Changed a category's discount and credit limit", group: "master" },
  setPayerTerms:          { label: "Changed a payer's discount and credit limit", group: "master" },
  // ---- support
  raiseTicket:            { label: "Raised a support ticket", group: "support" },
  replyToTicket:          { label: "Replied to a support ticket", group: "support" },
  setTicketStatus:        { label: "Changed a support ticket's status", group: "support" },
  rateTicket:             { label: "Rated a support ticket", group: "support" },
  replyAsDesk:            { label: "Replied as the support desk", group: "support" },
  setDeskTicketStatus:    { label: "Changed a support ticket's status at the desk", group: "support" },
};

/** The label and area to print for a stored row. `action` is a plain string because the row
 *  may predate the manifest it is read against: an action nobody labels any more prints as
 *  itself, in no area, rather than breaking the page. */
export function auditLabelOf(action: string, outcome: AuditOutcome): { label: string; group: AuditGroup | null } {
  if (!Object.hasOwn(AUDIT_LABELS, action)) return { label: action, group: null };
  const l = AUDIT_LABELS[action as AuditAction];
  return { label: outcome === "refused" && l.refused ? l.refused : l.label, group: l.group };
}

/** The action names an area filter matches, for the audit service's `action = any(...)`. */
export function actionsInGroup(group: AuditGroup): string[] {
  return Object.entries(AUDIT_LABELS).filter(([, l]) => l.group === group).map(([a]) => a);
}

/** The audit service's path prefix under `API_PREFIX`. Every `service: "audit"` route lives under
 *  it and no API route does, so one proxy rule (Vite, Caddy, nginx, the ingress) routes them all. */
export const AUDIT_PATH = "/admin/audit";
