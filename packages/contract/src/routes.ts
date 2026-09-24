import { z } from "zod";
import type { Action, Feature, Level, Role } from "./types.js";
import { OkResponseSchema } from "./schemas/common.js";
import { AuthResponseSchema, ChangePasswordBodySchema, LoginBodySchema, MeResponseSchema, PatchMeBodySchema, SignInDirectorySchema } from "./schemas/auth.js";
import { AdjustmentRequestsResponseSchema, AdjustmentsResponseSchema, BatchesResponseSchema, BILL_DAYS, BillsResponseSchema, ContractsResponseSchema, GrnsResponseSchema, ItemsResponseSchema, LocationsResponseSchema, MenusResponseSchema, PriceListsResponseSchema, PricesResponseSchema, ProdOrdersResponseSchema, ProductRequestsResponseSchema, PurchaseOrdersResponseSchema, RequestsResponseSchema, RequisitionsResponseSchema, RosterResponseSchema, ShopAsksResponseSchema, SnapshotSchema, TermsResponseSchema, StockResponseSchema, SupportTicketsResponseSchema, TicketsResponseSchema, VendorsResponseSchema } from "./schemas/snapshot.js";
import { CloseRegisterBodySchema, CreditParamsSchema, CreditResponseSchema, RegisterQuerySchema, RegisterReportSchema, RegisterReportsResponseSchema, StockLedgerQuerySchema, StockLedgerResponseSchema, ZReportsQuerySchema } from "./schemas/reports.js";
import { AdminActionSchema, AdminActionsQuerySchema, AdminDeletedUserSchema, AdminLocationSchema, AdminPayerParamsSchema, AdminPayerSchema, AdminRoleSchema, AdminUserIdParamsSchema, AdminUserSchema, AdminUserWithTempPasswordSchema, CreateAdminUserBodySchema, CreateOutletBodySchema, CreatePayerBodySchema, CreateRoleBodySchema, OutletKeyParamsSchema, RoleIdParamsSchema, SetAdminUserPostingsBodySchema, UpdateAdminUserBodySchema, UpdateOutletBodySchema, UpdatePayerBodySchema, UpdateRoleBodySchema } from "./schemas/admin.js";
import { ClassParamsSchema, ClassTermsSchema, PayerParamsSchema, PayerTermsSchema, ReceivablesResponseSchema, RecordSettlementBodySchema, SetClassTermsBodySchema, SetPayerTermsBodySchema, SettlementIdParamsSchema, SettlementSchema, SettlementsResponseSchema, StatementSchema, VoidSettlementBodySchema } from "./schemas/receivables.js";
import { CurrentShiftResponseSchema, ShiftReportSchema, ShiftReportsResponseSchema, ShiftsQuerySchema } from "./schemas/reports.js";
import { AuditEntrySchema, AuditIdParamsSchema, AuditPageSchema, AuditQuerySchema } from "./schemas/audit.js";
import { AdjustmentRequestSchema, AdjustmentSchema, BatchSchema, BillSchema, PriceListSchema, ProdOrderSchema, ProductRequestSchema, PurchaseOrderSchema, RateContractSchema, RequisitionSchema, ShopAskSchema, StockRequestSchema, SupportTicketSchema, TicketSchema, VendorSchema } from "./schemas/documents.js";
import { OutletPricesResultSchema, SaveOutletPricesBodySchema } from "./schemas/writes.js";
import { ActivatePriceListResultSchema, AddToProcurementListBodySchema, AnswerProductRequestBodySchema, AnswerShopAskBodySchema, ApproveAdjustmentRequestResultSchema, ApproveRequestBodySchema, ApproveRequisitionBodySchema, ApprovalResultSchema, CancelPoBodySchema, CancelTicketBodySchema, CloseShortBodySchema, ContractBodySchema, CreateAdjustmentBodySchema, CreateAdjustmentRequestBodySchema, CreateItemBodySchema, CreatePoBodySchema, CreatePriceListBodySchema, CreateProductRequestBodySchema, CreateRequestBodySchema, CreateRequisitionBodySchema, DeclineRequisitionBodySchema, DeclineShopAskBodySchema, DeletedPriceListSchema, DispatchResultSchema, DistributeBodySchema, DocIdParamsSchema, HandoverBodySchema, IssueResultSchema, MakeBatchBodySchema, MenuItemBodySchema, MenuItemParamsSchema, MenuLocParamsSchema, MenuResultSchema, OutletParamsSchema, PatchContractBodySchema, PatchPoBodySchema, PatchVendorBodySchema, PayBodySchema, PoLineParamsSchema, PriceListIdParamsSchema, PriceResultSchema, RaiseTicketBodySchema, RateTicketBodySchema, DeskReplyBodySchema, ReceiptResultSchema, ReceivePoBodySchema, RedirectRequestBodySchema, RejectAdjustmentRequestBodySchema, RejectRequestBodySchema, ReplyToTicketBodySchema, SavePriceBodySchema, SavePriceParamsSchema, SetOrderStatusBodySchema, SetOutletPriceListBodySchema, SetTicketStatusBodySchema, ShopAskBodySchema, ShopAskSentResultSchema, ToggleAvailBodySchema, ToggleResultSchema, TransferBodySchema, UpdatePoLineBodySchema, VendorBodySchema, writeResponse, ItemKeyParamsSchema, ItemResultSchema, PatchItemBodySchema, SetItemImageBodySchema, BillNoParamsSchema, VoidBillBodySchema, CreateProdOrderBodySchema } from "./schemas/writes.js";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
/** "public" needs no token; "any" needs a token of any role; "admin" needs the `admin` claim
 *  (an ordinary account flagged for account management, `pnpm --filter @rch/api users
 *  set-admin` - never a role); `{ needs }` names the permissions any one of which opens it
 *  (`need`, `act`, `anyOf`); `{ desk }` names the desks whose door it is (`desk`), for the few
 *  doors that belong to where someone works rather than to what their role grants. */
export type Access = "public" | "any" | "admin" | { needs: readonly Need[] } | { desk: readonly Role[] };

/** One thing a route may be reached by: a feature held at a level (edit implies view), or an
 *  action. A route's `needs` is any-of, the hospital-wide need listed first, so the first one met
 *  is the one whose scope the request runs under (`admits` in `@rch/domain`). */
export type Need = { f: Feature; l: Level } | { a: Action };
export const need = (f: Feature, l: Level): { needs: readonly Need[] } => ({ needs: [{ f, l }] });
export const act = (a: Action): { needs: readonly Need[] } => ({ needs: [{ a }] });
/** Any of these, in the order given - each a `Need` or a `need(...)`/`act(...)` of its own. */
export const anyOf = (...parts: readonly (Need | { needs: readonly Need[] })[]): { needs: readonly Need[] } =>
  ({ needs: parts.flatMap((p) => ("needs" in p ? p.needs : [p])) });
/** For the few doors that belong to a desk rather than a permission - a counter's own shift. */
export const desk = (...roles: readonly Role[]): { desk: readonly Role[] } => ({ desk: roles });

/** The deployable that answers a route. `apps/api` mounts only `"api"` routes and `apps/audit`
 *  only `"audit"` ones; each refuses the other's at `mount()`. */
export type Service = "api" | "audit";

/** `M`, `W` and `S` default to the wide types, so `AnyRoute` is what it always was. `defineRoute`
 *  infers them as literals, which is what lets `audit.ts` derive the write routes by type and
 *  fail typecheck on a new write that has no audit label. */
export interface Route<P extends z.ZodTypeAny, Q extends z.ZodTypeAny, B extends z.ZodTypeAny, R extends z.ZodTypeAny, M extends Method = Method, W extends boolean | undefined = boolean | undefined, S extends Service | undefined = Service | undefined> {
  method: M; path: string; access: Access;
  params?: P; query?: Q; body?: B; response: R;
  /** Writes require an Idempotency-Key header (Task 10). Defaults to method !== "GET". */
  write?: W;
  /** Reachable while must_change_password is set. Only auth and /me. */
  allowMcp?: boolean;
  /** Which deployable answers the route. Absent means `"api"` (`serviceOf`). */
  service?: S;
  /** Let the super admin through a route that is not `access: "admin"`, past every permission -
   *  the register's X, Z list and close, which the super admin reaches for any outlet it names. */
  admitAdmin?: true;
}
export type AnyRoute = Route<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>;
export const defineRoute = <P extends z.ZodTypeAny = z.ZodNever, Q extends z.ZodTypeAny = z.ZodNever, B extends z.ZodTypeAny = z.ZodNever, R extends z.ZodTypeAny = z.ZodTypeAny, M extends Method = Method, W extends boolean | undefined = undefined, S extends Service | undefined = undefined>(r: Route<P, Q, B, R, M, W, S>) => r;
/** The one reading of "is this a write": `write` when the manifest says, else anything but a GET. */
export const isWriteRoute = (r: AnyRoute): boolean => r.write ?? r.method !== "GET";
export const serviceOf = (r: AnyRoute): Service => r.service ?? "api";

export const routes = {
  login:          defineRoute({ method: "POST",  path: "/auth/login",           access: "public", body: LoginBodySchema, response: AuthResponseSchema, write: false, allowMcp: true }),
  refresh:        defineRoute({ method: "POST",  path: "/auth/refresh",         access: "public", response: AuthResponseSchema, write: false, allowMcp: true }),
  logout:         defineRoute({ method: "POST",  path: "/auth/logout",          access: "public", response: OkResponseSchema, write: false, allowMcp: true }),
  signInDirectory: defineRoute({ method: "GET",  path: "/auth/directory",       access: "public", response: SignInDirectorySchema }),
  changePassword: defineRoute({ method: "POST",  path: "/auth/change-password", access: "any",    body: ChangePasswordBodySchema, response: AuthResponseSchema, write: false, allowMcp: true }),
  me:             defineRoute({ method: "GET",   path: "/me",                   access: "any",    response: MeResponseSchema, allowMcp: true }),
  patchMe:        defineRoute({ method: "PATCH", path: "/me",                   access: "any",    body: PatchMeBodySchema, response: MeResponseSchema, allowMcp: true }),
  snapshot:       defineRoute({ method: "GET",   path: "/snapshot",             access: "any",    response: SnapshotSchema }),
  items:          defineRoute({ method: "GET",   path: "/items",                access: "any",    response: ItemsResponseSchema }),
  locations:      defineRoute({ method: "GET",   path: "/locations",            access: "any",    response: LocationsResponseSchema }),
  prices:         defineRoute({ method: "GET",   path: "/prices",               access: "any",    response: PricesResponseSchema }),
  // The price lists themselves, named and with their outlets - the manager's management screen.
  // Every till already gets the flat item->price maps from `prices`; this is master data about
  // the lists, not needed to price a sale.
  priceLists:     defineRoute({ method: "GET",   path: "/price-lists",          access: need("prices", "view"), response: PriceListsResponseSchema }),
  menus:          defineRoute({ method: "GET",   path: "/menus",                access: "any",    response: MenusResponseSchema }),
  pay:            defineRoute({ method: "POST",   path: "/bills",                      access: need("billing", "edit"),            body: PayBodySchema,        response: writeResponse(BillSchema) }),
  // `prod` is here for the kitchen's own switch: the Central Kitchen decides what it is making
  // today, exactly as a counter decides what it is selling. Scoping is per role in the handler.
  toggleAvail:    defineRoute({ method: "POST",   path: "/availability/toggle",        access: need("availability", "edit"), body: ToggleAvailBodySchema, response: writeResponse(ToggleResultSchema) }),
  savePrice:      defineRoute({ method: "PUT",    path: "/prices/:list/:it",           access: need("prices", "edit"),            params: SavePriceParamsSchema, body: SavePriceBodySchema, response: writeResponse(PriceResultSchema) }),
  // ---- price lists ---- a list stays editable at any time, active or not, exactly like
  // `savePrice` above; these three manage the list itself: create (cloned from an outlet),
  // delete (only once no outlet points at it) and switch which list an outlet is active on.
  createPriceList:    defineRoute({ method: "POST",   path: "/price-lists",              access: need("prices", "edit"), body: CreatePriceListBodySchema, response: writeResponse(PriceListSchema) }),
  deletePriceList:    defineRoute({ method: "DELETE", path: "/price-lists/:id",          access: need("prices", "edit"), params: PriceListIdParamsSchema, response: writeResponse(DeletedPriceListSchema) }),
  setOutletPriceList: defineRoute({ method: "PUT",    path: "/outlets/:loc/price-list",  access: need("prices", "edit"), params: OutletParamsSchema, body: SetOutletPriceListBodySchema, response: writeResponse(ActivatePriceListResultSchema) }),
  // ---- counter prices ---- the manager's price grid: every sellable item against every open
  // outlet, saved as one batch. Each outlet it touches gets a list of its own first, so a price
  // typed for one counter never moves another's.
  saveOutletPrices:   defineRoute({ method: "PUT",    path: "/outlet-prices",            access: need("prices", "edit"), body: SaveOutletPricesBodySchema, response: writeResponse(OutletPricesResultSchema) }),
  addMenuItem:    defineRoute({ method: "POST",   path: "/menus/:loc/items",           access: need("menu", "edit"),            params: MenuLocParamsSchema, body: MenuItemBodySchema, response: writeResponse(MenuResultSchema) }),
  removeMenuItem: defineRoute({ method: "DELETE", path: "/menus/:loc/items/:it",       access: need("menu", "edit"),            params: MenuItemParamsSchema, response: writeResponse(MenuResultSchema) }),
  stock:          defineRoute({ method: "GET",    path: "/stock",                      access: "any",                  response: StockResponseSchema }),
  bills:          defineRoute({ method: "GET",    path: "/bills",                      access: "any",                  query: z.strictObject({ days: z.coerce.number().int().min(1).max(90).default(BILL_DAYS) }), response: BillsResponseSchema }),
  createRequest:  defineRoute({ method: "POST", path: "/requests",                  access: anyOf(need("outlet_requests", "edit"), need("kitchen_requests", "edit")),            body: CreateRequestBodySchema,   response: writeResponse(StockRequestSchema) }),
  cancelRequest:  defineRoute({ method: "POST", path: "/requests/:id/cancel",       access: anyOf(need("approvals", "edit"), need("outlet_requests", "edit"), need("kitchen_requests", "edit")), params: DocIdParamsSchema,       response: writeResponse(StockRequestSchema) }),
  approveRequest: defineRoute({ method: "POST", path: "/requests/:id/approve",      access: need("approvals", "edit"),                    params: DocIdParamsSchema, body: ApproveRequestBodySchema, response: writeResponse(ApprovalResultSchema) }),
  rejectRequest:  defineRoute({ method: "POST", path: "/requests/:id/reject",       access: need("approvals", "edit"),                    params: DocIdParamsSchema, body: RejectRequestBodySchema,  response: writeResponse(StockRequestSchema) }),
  redirectRequest: defineRoute({ method: "POST", path: "/requests/:id/redirect",    access: need("approvals", "edit"),                    params: DocIdParamsSchema, body: RedirectRequestBodySchema, response: writeResponse(IssueResultSchema) }),
  issueTicket:    defineRoute({ method: "POST", path: "/requests/:id/issue-ticket", access: need("issue_desk", "edit"),                      params: DocIdParamsSchema,       response: writeResponse(IssueResultSchema) }),
  // `counter` is here for a shop transfer's own ticket: the outlet that granted it
  // hands it over. No counter screen calls it yet; the route exists so Phase 6 adds a button, not a route.
  handover:       defineRoute({ method: "POST", path: "/tickets/:id/handover",      access: anyOf(need("issue_desk", "edit"), need("kitchen_tickets", "edit"), need("outlet_tickets", "edit")),   params: DocIdParamsSchema, body: HandoverBodySchema,       response: writeResponse(TicketSchema) }),
  receiveTicket:  defineRoute({ method: "POST", path: "/tickets/:id/receive",       access: anyOf(need("issue_desk", "edit"), need("kitchen_tickets", "edit"), need("outlet_tickets", "edit")),   params: DocIdParamsSchema,       response: writeResponse(TicketSchema) }),
  transfer:       defineRoute({ method: "POST", path: "/transfers",                 access: anyOf(need("items_stock", "edit"), need("outlet_tickets", "edit")),         body: TransferBodySchema,        response: writeResponse(TicketSchema) }),
  askShop:        defineRoute({ method: "POST", path: "/shop-asks",                 access: need("outlet_requests", "edit"),                    body: ShopAskBodySchema,         response: writeResponse(ShopAskSchema) }),
  answerShopAsk:  defineRoute({ method: "POST", path: "/shop-asks/:id/answer",      access: need("outlet_requests", "edit"),                    params: DocIdParamsSchema, body: AnswerShopAskBodySchema,  response: writeResponse(ShopAskSentResultSchema) }),
  declineShopAsk: defineRoute({ method: "POST", path: "/shop-asks/:id/decline",     access: need("outlet_requests", "edit"),                    params: DocIdParamsSchema, body: DeclineShopAskBodySchema, response: writeResponse(ShopAskSchema) }),
  dispatchProdOrder: defineRoute({ method: "POST", path: "/prod-orders/:id/dispatch", access: need("kitchen_orders", "edit"), params: DocIdParamsSchema, response: writeResponse(DispatchResultSchema) }),
  distribute:        defineRoute({ method: "POST", path: "/distributions",            access: need("make_distribute", "edit"), body: DistributeBodySchema,  response: writeResponse(TicketSchema) }),
  setOrderStatus: defineRoute({ method: "POST", path: "/prod-orders/:id/status", access: need("kitchen_orders", "edit"),           params: DocIdParamsSchema, body: SetOrderStatusBodySchema, response: writeResponse(ProdOrderSchema) }),
  makeBatch:      defineRoute({ method: "POST", path: "/batches",                access: need("make_distribute", "edit"),           body: MakeBatchBodySchema,                                 response: writeResponse(BatchSchema) }),
  // The store cancels the store's tickets, the kitchen the kitchen's, and - from Phase 6 - an
  // outlet its own: a shop transfer and a granted shop ask both leave from an outlet, and until
  // now `requireLocOf` on the ticket's `from` put them out of everyone's reach rather than into
  // the counter's. The scoping is unchanged; only the door is wider.
  cancelTicket:   defineRoute({ method: "POST", path: "/tickets/:id/cancel",     access: anyOf(need("issue_desk", "edit"), need("kitchen_tickets", "edit"), need("outlet_tickets", "edit")),  params: DocIdParamsSchema, body: CancelTicketBodySchema,   response: writeResponse(TicketSchema) }),
  // ---- Buying. The store keeper asks, the buyer decides and orders, and
  // either of them books the goods in. Reads are declared beside their handlers, further down.
  createRequisition:    defineRoute({ method: "POST",   path: "/requisitions",                  access: need("store_requisitions", "edit"),            body: CreateRequisitionBodySchema,  response: writeResponse(RequisitionSchema) }),
  approveRequisition:   defineRoute({ method: "POST",   path: "/requisitions/:id/approve",      access: need("requisitions", "edit"),            params: DocIdParamsSchema, body: ApproveRequisitionBodySchema, response: writeResponse(RequisitionSchema) }),
  declineRequisition:   defineRoute({ method: "POST",   path: "/requisitions/:id/decline",      access: need("requisitions", "edit"),            params: DocIdParamsSchema, body: DeclineRequisitionBodySchema, response: writeResponse(RequisitionSchema) }),
  // The buyer's own addition to the procurement list: a requisition raised and approved in one
  // step, so every purchase order, receipt and shortfall still claims against a requisition line.
  addToProcurementList: defineRoute({ method: "POST",   path: "/requisitions/direct",           access: need("procurement_list", "edit"),            body: AddToProcurementListBodySchema, response: writeResponse(RequisitionSchema) }),
  createPo:             defineRoute({ method: "POST",   path: "/purchase-orders",               access: need("procurement_list", "edit"),            body: CreatePoBodySchema,           response: writeResponse(PurchaseOrderSchema) }),
  updatePoLine:         defineRoute({ method: "PATCH",  path: "/purchase-orders/:id/lines/:n",  access: need("purchase_orders", "edit"),            params: PoLineParamsSchema, body: UpdatePoLineBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  removePoLine:         defineRoute({ method: "DELETE", path: "/purchase-orders/:id/lines/:n",  access: need("purchase_orders", "edit"),            params: PoLineParamsSchema,         response: writeResponse(PurchaseOrderSchema) }),
  patchPo:              defineRoute({ method: "PATCH",  path: "/purchase-orders/:id",           access: need("purchase_orders", "edit"),            params: DocIdParamsSchema, body: PatchPoBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  sendPo:               defineRoute({ method: "POST",   path: "/purchase-orders/:id/send",      access: need("purchase_orders", "edit"),            params: DocIdParamsSchema,          response: writeResponse(PurchaseOrderSchema) }),
  cancelPo:             defineRoute({ method: "POST",   path: "/purchase-orders/:id/cancel",    access: need("purchase_orders", "edit"),            params: DocIdParamsSchema, body: CancelPoBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  // The buyer receives against the order they raised; the store keeper receives at the door.
  receivePo:            defineRoute({ method: "POST",   path: "/purchase-orders/:id/receive",   access: need("goods_receipt", "edit"),   params: DocIdParamsSchema, body: ReceivePoBodySchema, response: writeResponse(ReceiptResultSchema) }),
  closePoShort:         defineRoute({ method: "POST",   path: "/purchase-orders/:id/close-short", access: need("purchase_orders", "edit"),          params: DocIdParamsSchema, body: CloseShortBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  addVendor:            defineRoute({ method: "POST",   path: "/vendors",                       access: need("vendors", "edit"),            body: VendorBodySchema,             response: writeResponse(VendorSchema) }),
  // One PATCH for both the edit and the on/off switch: `setVendorActive` is a patch of one field.
  updateVendor:         defineRoute({ method: "PATCH",  path: "/vendors/:id",                   access: need("vendors", "edit"),            params: DocIdParamsSchema, body: PatchVendorBodySchema, response: writeResponse(VendorSchema) }),
  addContract:          defineRoute({ method: "POST",   path: "/contracts",                     access: need("rate_contracts", "edit"),            body: ContractBodySchema,           response: writeResponse(RateContractSchema) }),
  updateContract:       defineRoute({ method: "PATCH",  path: "/contracts/:id",                 access: need("rate_contracts", "edit"),            params: DocIdParamsSchema, body: PatchContractBodySchema, response: writeResponse(RateContractSchema) }),
  removeContract:       defineRoute({ method: "DELETE", path: "/contracts/:id",                 access: need("rate_contracts", "edit"),            params: DocIdParamsSchema,          response: writeResponse(RateContractSchema) }),
  // Three screens add a product: the kitchen's own (FG and RAW, at the kitchen), the store's,
  // and the buyer's answer to a shop's request.
  createItem:           defineRoute({ method: "POST",   path: "/items",                         access: need("item_master", "edit"), body: CreateItemBodySchema,   response: writeResponse(ItemResultSchema) }),
  createProductRequest: defineRoute({ method: "POST",   path: "/product-requests",              access: anyOf(need("menu", "edit"), need("outlet_requests", "edit")), body: CreateProductRequestBodySchema, response: writeResponse(ProductRequestSchema) }),
  answerProductRequest: defineRoute({ method: "POST",   path: "/product-requests/:id/answer",   access: anyOf(need("new_products", "edit"), need("store_requisitions", "edit")),   params: DocIdParamsSchema, body: AnswerProductRequestBodySchema, response: writeResponse(ProductRequestSchema) }),
  // The five movement collections, each on its own, so a write that names "req", "tkt",
  // "shopAsks", "pord" or "batch" in `changed` refetches that slice and not the whole snapshot.
  // `ticketsList` rather than `tickets`, because `tickets` is the support-ticket collection and
  // will be the Phase 6 route name - two manifest keys must not collide.
  requests:    defineRoute({ method: "GET", path: "/requests",   access: "any", response: RequestsResponseSchema }),
  ticketsList: defineRoute({ method: "GET", path: "/tickets",    access: "any", response: TicketsResponseSchema }),
  shopAsks:    defineRoute({ method: "GET", path: "/shop-asks",  access: "any", response: ShopAsksResponseSchema }),
  // The kitchen's two collections, likewise: a make names "batch" and "stock", a status change
  // names "pord", and each refetches its own slice instead of the whole snapshot.
  prodOrders:  defineRoute({ method: "GET", path: "/prod-orders", access: "any", response: ProdOrdersResponseSchema }),
  batches:     defineRoute({ method: "GET", path: "/batches",     access: "any", response: BatchesResponseSchema }),
  // Buying's six, each answering for one slice a write can name in `changed`.
  requisitions:    defineRoute({ method: "GET", path: "/requisitions",     access: "any", response: RequisitionsResponseSchema }),
  purchaseOrders:  defineRoute({ method: "GET", path: "/purchase-orders",  access: "any", response: PurchaseOrdersResponseSchema }),
  grns:            defineRoute({ method: "GET", path: "/grns",             access: "any", response: GrnsResponseSchema }),
  vendors:         defineRoute({ method: "GET", path: "/vendors",          access: "any", response: VendorsResponseSchema }),
  contracts:       defineRoute({ method: "GET", path: "/contracts",        access: "any", response: ContractsResponseSchema }),
  productRequests: defineRoute({ method: "GET", path: "/product-requests", access: "any", response: ProductRequestsResponseSchema }),
  // ---- The support desk. Every role, own tickets only: `access: "any"`
  // opens the module to all five, and the service scopes each row on `by_user = claims.sub`.
  // A ticket somebody else raised is a 404, not a 403 - the same shape as a role's missing module.
  raiseTicket:     defineRoute({ method: "POST", path: "/support/tickets",              access: "any", body: RaiseTicketBodySchema,     response: writeResponse(SupportTicketSchema) }),
  replyToTicket:   defineRoute({ method: "POST", path: "/support/tickets/:id/messages", access: "any", params: DocIdParamsSchema, body: ReplyToTicketBodySchema,   response: writeResponse(SupportTicketSchema) }),
  setTicketStatus: defineRoute({ method: "POST", path: "/support/tickets/:id/status",   access: "any", params: DocIdParamsSchema, body: SetTicketStatusBodySchema, response: writeResponse(SupportTicketSchema) }),
  rateTicket:      defineRoute({ method: "POST", path: "/support/tickets/:id/rating",   access: "any", params: DocIdParamsSchema, body: RateTicketBodySchema,      response: writeResponse(SupportTicketSchema) }),
  // `tickets`, not `supportTickets`: the name was reserved for this route when `ticketsList`
  // was named, so the manifest key matches the `changed` collection the writes above name.
  tickets:         defineRoute({ method: "GET",  path: "/support/tickets",              access: "any", response: SupportTicketsResponseSchema }),
  // ---- Reports. Two figures a caller cannot compute from its own snapshot:
  // the ledger, which needs `stock_moves` and which the browser had to reconstruct backwards from
  // receipts and issues, and what a payer still owes, which needs every outlet's bills and every
  // settlement against them and which the till could only approximate from its own seven days.
  // Every other report and every dashboard reads a slice the snapshot already carries whole and
  // stays in the browser.
  stockLedger:  defineRoute({ method: "GET", path: "/reports/stock-ledger",     access: need("stock_ledger", "view"), query: StockLedgerQuerySchema, response: StockLedgerResponseSchema }),
  // The payer figure serves the till's payer pick (Bills at edit) and either half of Credit: it is
  // the ceiling from the rate card against what the settlements have not cleared.
  creditReport: defineRoute({ method: "GET", path: "/reports/credit/:kind/:id", access: anyOf(need("credit", "view"), need("settlements", "view"), need("billing", "edit")), params: CreditParamsSchema,   response: CreditResponseSchema }),
  // ---- the register. An X changes nothing and may be taken as often as anyone likes, so it is a
  // GET; a Z closes the outlet's session and opens the next, so it is a write and carries an
  // Idempotency-Key like every other write - a retried close must replay its Z, never mint a
  // second one. The X is `x_report`'s, the Z list `z_report` at view and the close `z_report` at
  // edit - at the caller's own outlet unless their role works every outlet. No seeded role holds
  // `z_report`: closing the day is the super admin's (`admitAdmin`, naming the outlet) until the
  // administrator gives a role it.
  xReport:      defineRoute({ method: "GET",  path: "/register/x",          access: need("x_report", "view"), admitAdmin: true, query: RegisterQuerySchema,     response: RegisterReportSchema }),
  closeRegister:defineRoute({ method: "POST", path: "/register/close",      access: need("z_report", "edit"), admitAdmin: true, body: CloseRegisterBodySchema,  response: writeResponse(RegisterReportSchema) }),
  zReports:     defineRoute({ method: "GET",  path: "/register/z",          access: need("z_report", "view"), admitAdmin: true, query: ZReportsQuerySchema,     response: RegisterReportsResponseSchema }),
  // ---- shifts: one operator's stint at one counter, opened by their sign-in there. The live
  // report and the close are the operator's own; the list is "any" and scoped (a manager reads
  // every outlet's, a counter its own, everyone else an empty list), because a close announces
  // "shifts" to every open browser - the same reason `/receivables` is "any".
  currentShift: defineRoute({ method: "GET",  path: "/shifts/current",      access: desk("counter"),            response: CurrentShiftResponseSchema }),
  closeShift:   defineRoute({ method: "POST", path: "/shifts/close",        access: desk("counter"),            response: writeResponse(ShiftReportSchema) }),
  shifts:       defineRoute({ method: "GET",  path: "/shifts",              access: "any",                  query: ShiftsQuerySchema,       response: ShiftReportsResponseSchema }),
  // ---- payers (the roster behind every non-cash tender). The register itself is the super
  // admin's (`/admin/payers`, below); the CSV import stays for a ward list nobody types twice.
  // `GET /roster` is the till's read, live payers only, "any" and scoped like the snapshot's own
  // copy: a caller who never opens a payer picker reads an empty register.
  roster: defineRoute({ method: "GET", path: "/roster", access: "any", response: RosterResponseSchema }),
  // ---- what each party is charged, and what they owe.
  //
  // Two features, not one. `credit` is the rate card - each category's discount and credit
  // ceiling and the per-person exceptions over them. `settlements` is the other half: who owes
  // what, one party's statement, and recording a payment against it; voiding one is the
  // `void_settlement` action under it. Of the seeded roles only the Outlet Manager holds either.
  //
  // `GET /payer-terms` is "any" and scoped empty to a role holding none of Bills, `credit` and
  // `settlements`, exactly like the roster above. That is deliberate rather than tidy: a rate-card
  // write announces "terms" to *every* open browser, and a route the store keeper's tab is
  // forbidden would fail that tab's whole refetch with a toast about a screen of theirs that never
  // changed.
  payerTerms:      defineRoute({ method: "GET", path: "/payer-terms",             access: "any",       response: TermsResponseSchema }),
  setClassTerms:   defineRoute({ method: "PUT", path: "/payer-terms/class/:cls",  access: need("credit", "edit"), params: ClassParamsSchema, body: SetClassTermsBodySchema, response: writeResponse(ClassTermsSchema) }),
  setPayerTerms:   defineRoute({ method: "PUT", path: "/payer-terms/:kind/:id",   access: need("credit", "edit"), params: PayerParamsSchema, body: SetPayerTermsBodySchema, response: writeResponse(PayerTermsSchema) }),
  // The two lists behind the Credit screen's Owed and Payments tabs are "any" and answer `[]` to
  // a role without `settlements`, for the same reason `/roster` and `/payer-terms` are: a settlement announces
  // "receivables" to every open browser, and a route a store keeper's tab is forbidden would
  // fail that tab's whole refetch over a screen of theirs that never changed. The service
  // short-circuits before it queries anything, so an empty answer costs nothing.
  receivables:     defineRoute({ method: "GET", path: "/receivables",             access: "any",       response: ReceivablesResponseSchema }),
  settlements:     defineRoute({ method: "GET", path: "/settlements",             access: "any",       response: SettlementsResponseSchema }),
  // One party's statement is opened by hand from a drawer and is never in a `changed`, so it can
  // stay closed to a role without `settlements`.
  statement:       defineRoute({ method: "GET", path: "/receivables/:kind/:id",   access: need("settlements", "view"), params: PayerParamsSchema, response: StatementSchema }),
  recordSettlement: defineRoute({ method: "POST", path: "/settlements",           access: need("settlements", "edit"), body: RecordSettlementBodySchema, response: writeResponse(SettlementSchema) }),
  voidSettlement:  defineRoute({ method: "POST", path: "/settlements/:id/void",   access: act("void_settlement"), params: SettlementIdParamsSchema, body: VoidSettlementBodySchema, response: writeResponse(SettlementSchema) }),
  // ---- item patch ----
  // The item master stopped being write-once. A role holding Items & stock or Item master at edit
  // reaches this door; which of the fields it may actually move is `ITEM_FIELD_FEATURES`
  // (`@rch/domain`), refused in the service with a sentence naming the feature it needs. No seeded
  // counter holds either, for the same reason it holds no `POST /items`: a till sells the master.
  patchItem:    defineRoute({ method: "PATCH", path: "/items/:it", access: anyOf(need("items_stock", "edit"), need("item_master", "edit")), params: ItemKeyParamsSchema, body: PatchItemBodySchema, response: writeResponse(ItemResultSchema) }),
  // ---- item photos ----
  // The manager for any item, a counter for what its own outlet lists (the service's rule, a
  // 403 naming the outlet). The photo itself is read at `ITEM_IMAGE_PATH`, outside the manifest.
  setItemImage:    defineRoute({ method: "PUT",    path: "/items/:it/image", access: need("item_photos", "edit"), params: ItemKeyParamsSchema, body: SetItemImageBodySchema, response: writeResponse(ItemResultSchema) }),
  removeItemImage: defineRoute({ method: "DELETE", path: "/items/:it/image", access: need("item_photos", "edit"), params: ItemKeyParamsSchema, response: writeResponse(ItemResultSchema) }),
  // ---- bill void. The manager's door, and only the manager's: a till that could unsell its own
  // takings is not a till anybody reconciles. Same IST day is the service's rule, so a bill from
  // yesterday reads a sentence naming the day it belongs to rather than a missing button.
  // `:no` is a bill number and carries a slash, so it arrives percent-encoded (`CF%2F1188`).
  voidBill:     defineRoute({ method: "POST", path: "/bills/:no/void",            access: act("void_bill"),                          params: BillNoParamsSchema, body: VoidBillBodySchema, response: writeResponse(BillSchema) }),
  // ---- adjustments. A write-off or a count-up as a document, with a reason and a signature -
  // the store keeper and the kitchen correct their own shelves directly. An outlet's is the one
  // exception: the manager no longer adjusts it directly, only through the request pair below,
  // which is why "manager" is not in this list.
  createAdjustment: defineRoute({ method: "POST", path: "/adjustments", access: need("adjustments", "edit"), body: CreateAdjustmentBodySchema, response: writeResponse(AdjustmentSchema) }),
  adjustments:      defineRoute({ method: "GET",  path: "/adjustments", access: "any",             response: AdjustmentsResponseSchema }),
  // ---- adjustment requests. A counter's ask to correct its own shelf, which the outlet manager
  // approves (writing the `ADJ-` document in the same step) or rejects. There is no issue-ticket
  // stage after "Approved" - a write-off has no hand-off to scan, so approving one is the whole
  // of the movement.
  createAdjustmentRequest:  defineRoute({ method: "POST", path: "/adjustment-requests",            access: need("outlet_stock", "edit"),            body: CreateAdjustmentRequestBodySchema, response: writeResponse(AdjustmentRequestSchema) }),
  cancelAdjustmentRequest:  defineRoute({ method: "POST", path: "/adjustment-requests/:id/cancel",  access: anyOf(need("approvals", "edit"), need("outlet_stock", "edit")), params: DocIdParamsSchema, response: writeResponse(AdjustmentRequestSchema) }),
  approveAdjustmentRequest: defineRoute({ method: "POST", path: "/adjustment-requests/:id/approve", access: need("approvals", "edit"),            params: DocIdParamsSchema, response: writeResponse(ApproveAdjustmentRequestResultSchema) }),
  rejectAdjustmentRequest:  defineRoute({ method: "POST", path: "/adjustment-requests/:id/reject",  access: need("approvals", "edit"),            params: DocIdParamsSchema, body: RejectAdjustmentRequestBodySchema, response: writeResponse(AdjustmentRequestSchema) }),
  adjustmentRequests:       defineRoute({ method: "GET",  path: "/adjustment-requests",             access: "any",                  response: AdjustmentRequestsResponseSchema }),
  // ---- prod-order raise ---- the other end of the kitchen's board. `dispatch` and the board's
  // statuses act on orders nobody could raise; this is how one arrives. A counter raises for its
  // own outlet (the route pins `from` to the token) and the manager raises for any of the three,
  // naming it - the same split `createRequest` and `approveRequest` already draw between a desk
  // that owns one location and a role that supervises them all.
  createProdOrder: defineRoute({ method: "POST", path: "/prod-orders", access: anyOf(need("approvals", "edit"), need("outlet_requests", "edit")), body: CreateProdOrderBodySchema, response: writeResponse(ProdOrderSchema) }),
  // ---- admin: account management. A capability, not a role - `access: "admin"` checks the
  // `admin` claim (root CLAUDE.md), never `req.user.role`, so every one of these is reachable
  // from an ordinary account of any role that has been flagged, and from none that has not.
  // Granting or revoking the flag itself is not among them: there is no
  // route here for it, only `pnpm --filter @rch/api users set-admin`.
  adminUsers:            defineRoute({ method: "GET",   path: "/admin/users",                     access: "admin", response: z.array(AdminUserSchema) }),
  createAdminUser:       defineRoute({ method: "POST",  path: "/admin/users",                      access: "admin", body: CreateAdminUserBodySchema, response: writeResponse(AdminUserWithTempPasswordSchema) }),
  resetAdminUserPassword: defineRoute({ method: "POST", path: "/admin/users/:id/reset-password",   access: "admin", params: AdminUserIdParamsSchema, response: writeResponse(AdminUserWithTempPasswordSchema) }),
  deactivateAdminUser:   defineRoute({ method: "POST",  path: "/admin/users/:id/deactivate",       access: "admin", params: AdminUserIdParamsSchema, response: writeResponse(AdminUserSchema) }),
  reactivateAdminUser:   defineRoute({ method: "POST",  path: "/admin/users/:id/reactivate",       access: "admin", params: AdminUserIdParamsSchema, response: writeResponse(AdminUserSchema) }),
  updateAdminUser:       defineRoute({ method: "PATCH", path: "/admin/users/:id",                  access: "admin", params: AdminUserIdParamsSchema, body: UpdateAdminUserBodySchema, response: writeResponse(AdminUserSchema) }),
  // ---- postings. Its own route rather than a third key on the PATCH body: the role-and-location
  // move and the posting list are two different decisions, they are logged as two different
  // actions, and changing the list revokes every session while a role move does not.
  setAdminUserPostings: defineRoute({ method: "PUT",   path: "/admin/users/:id/postings",         access: "admin", params: AdminUserIdParamsSchema, body: SetAdminUserPostingsBodySchema, response: writeResponse(AdminUserSchema) }),
  deleteAdminUser:       defineRoute({ method: "DELETE", path: "/admin/users/:id",                 access: "admin", params: AdminUserIdParamsSchema, response: writeResponse(AdminDeletedUserSchema) }),
  adminActions:          defineRoute({ method: "GET",   path: "/admin/actions",                    access: "admin", query: AdminActionsQuerySchema, response: z.array(AdminActionSchema) }),
  // ---- admin: the payer register. Who a bill may be posted to - consultants, staff, wards and
  // cost centres - opened, renamed and switched off here. There is no delete: a payer with a bill
  // against them is somebody's balance, and an id that vanishes is a debt nobody can find. What
  // each of them is charged is the outlet manager's, at `/payer-terms` above.
  adminPayers:           defineRoute({ method: "GET",   path: "/admin/payers",                     access: "admin", response: z.array(AdminPayerSchema) }),
  createPayer:           defineRoute({ method: "POST",  path: "/admin/payers",                     access: "admin", body: CreatePayerBodySchema, response: writeResponse(AdminPayerSchema) }),
  updatePayer:           defineRoute({ method: "PATCH", path: "/admin/payers/:kind/:id",           access: "admin", params: AdminPayerParamsSchema, body: UpdatePayerBodySchema, response: writeResponse(AdminPayerSchema) }),
  // ---- admin: roles & permissions. A role is a name, the desk it works at and what it may see and
  // change; every account holds one. Deactivated only once nobody active holds it, and deleted only
  // if nobody ever did. A change reaches its holders on their next request (`apps/api`'s
  // permission cache), never through the token.
  adminRoles:            defineRoute({ method: "GET",    path: "/admin/roles",                     access: "admin", response: z.array(AdminRoleSchema) }),
  createRole:            defineRoute({ method: "POST",   path: "/admin/roles",                     access: "admin", body: CreateRoleBodySchema, response: writeResponse(AdminRoleSchema) }),
  updateRole:            defineRoute({ method: "PATCH",  path: "/admin/roles/:id",                 access: "admin", params: RoleIdParamsSchema, body: UpdateRoleBodySchema, response: writeResponse(AdminRoleSchema) }),
  deactivateRole:        defineRoute({ method: "POST",   path: "/admin/roles/:id/deactivate",      access: "admin", params: RoleIdParamsSchema, response: writeResponse(AdminRoleSchema) }),
  reactivateRole:        defineRoute({ method: "POST",   path: "/admin/roles/:id/reactivate",      access: "admin", params: RoleIdParamsSchema, response: writeResponse(AdminRoleSchema) }),
  deleteRole:            defineRoute({ method: "DELETE", path: "/admin/roles/:id",                 access: "admin", params: RoleIdParamsSchema, response: writeResponse(AdminRoleSchema) }),
  // ---- admin: outlets. Opened, edited, closed and reopened here and nowhere else - never deleted
  // (root CLAUDE.md). The store and the kitchen are fixed: the outlet routes answer 404 for either.
  adminLocations:        defineRoute({ method: "GET",   path: "/admin/locations",                 access: "admin", response: z.array(AdminLocationSchema) }),
  createOutlet:          defineRoute({ method: "POST",  path: "/admin/outlets",                    access: "admin", body: CreateOutletBodySchema, response: writeResponse(AdminLocationSchema) }),
  updateOutlet:          defineRoute({ method: "PATCH", path: "/admin/outlets/:key",               access: "admin", params: OutletKeyParamsSchema, body: UpdateOutletBodySchema, response: writeResponse(AdminLocationSchema) }),
  closeOutlet:           defineRoute({ method: "POST",  path: "/admin/outlets/:key/close",         access: "admin", params: OutletKeyParamsSchema, response: writeResponse(AdminLocationSchema) }),
  reopenOutlet:          defineRoute({ method: "POST",  path: "/admin/outlets/:key/reopen",        access: "admin", params: OutletKeyParamsSchema, response: writeResponse(AdminLocationSchema) }),
  // ---- admin: the support desk. The other end of every role's own Support screen: the admin
  // reads every ticket, whoever raised it, and answers as support. Its writes name `tickets` in
  // `changed`, so the reporter's own screen refetches its list and sees the reply live.
  deskTickets:           defineRoute({ method: "GET",   path: "/admin/support/tickets",            access: "admin", response: SupportTicketsResponseSchema }),
  replyAsDesk:           defineRoute({ method: "POST",  path: "/admin/support/tickets/:id/messages", access: "admin", params: DocIdParamsSchema, body: DeskReplyBodySchema, response: writeResponse(SupportTicketSchema) }),
  setDeskTicketStatus:   defineRoute({ method: "POST",  path: "/admin/support/tickets/:id/status", access: "admin", params: DocIdParamsSchema, body: SetTicketStatusBodySchema, response: writeResponse(SupportTicketSchema) }),
  // ---- admin: the audit log. Answered by `apps/audit`, not by the API: `service: "audit"` is what
  // keeps these out of the API's `mount()` and in the audit service's. Both live under
  // `AUDIT_PATH`, so every proxy in front of the two services routes them with one prefix rule.
  auditLog:   defineRoute({ method: "GET", path: "/admin/audit",     access: "admin", service: "audit", query: AuditQuerySchema,     response: AuditPageSchema }),
  auditEntry: defineRoute({ method: "GET", path: "/admin/audit/:id", access: "admin", service: "audit", params: AuditIdParamsSchema, response: AuditEntrySchema }),
} as const;
export type RouteName = keyof typeof routes;
export const API_PREFIX = "/api/v1";
