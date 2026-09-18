import { z } from "zod";
import type { Role } from "./types.js";
import { OkResponseSchema } from "./schemas/common.js";
import { AuthResponseSchema, ChangePasswordBodySchema, LoginBodySchema, MeResponseSchema, PatchMeBodySchema, SignInDirectorySchema } from "./schemas/auth.js";
import { AdjustmentRequestsResponseSchema, AdjustmentsResponseSchema, BatchesResponseSchema, BILL_DAYS, BillsResponseSchema, ContractsResponseSchema, GrnsResponseSchema, ItemsResponseSchema, LocationsResponseSchema, MenusResponseSchema, PriceListsResponseSchema, PricesResponseSchema, ProdOrdersResponseSchema, ProductRequestsResponseSchema, PurchaseOrdersResponseSchema, RequestsResponseSchema, RequisitionsResponseSchema, RosterResponseSchema, ShopAsksResponseSchema, SnapshotSchema, TermsResponseSchema, StockResponseSchema, SupportTicketsResponseSchema, TicketsResponseSchema, VendorsResponseSchema } from "./schemas/snapshot.js";
import { CloseRegisterBodySchema, CreditParamsSchema, CreditResponseSchema, RegisterQuerySchema, RegisterReportSchema, RegisterReportsResponseSchema, StockLedgerQuerySchema, StockLedgerResponseSchema, ZReportsQuerySchema } from "./schemas/reports.js";
import { AdminActionSchema, AdminActionsQuerySchema, AdminDeletedUserSchema, AdminLocationSchema, AdminPayerParamsSchema, AdminPayerSchema, AdminUserIdParamsSchema, AdminUserSchema, AdminUserWithTempPasswordSchema, CreateAdminUserBodySchema, CreateOutletBodySchema, CreatePayerBodySchema, OutletKeyParamsSchema, SetAdminUserPostingsBodySchema, UpdateAdminUserBodySchema, UpdateOutletBodySchema, UpdatePayerBodySchema } from "./schemas/admin.js";
import { ClassParamsSchema, ClassTermsSchema, PayerParamsSchema, PayerTermsSchema, ReceivablesResponseSchema, RecordSettlementBodySchema, SetClassTermsBodySchema, SetPayerTermsBodySchema, SettlementIdParamsSchema, SettlementSchema, SettlementsResponseSchema, StatementSchema, VoidSettlementBodySchema } from "./schemas/receivables.js";
import { AuditEntrySchema, AuditIdParamsSchema, AuditPageSchema, AuditQuerySchema } from "./schemas/audit.js";
import { AdjustmentRequestSchema, AdjustmentSchema, BatchSchema, BillSchema, PriceListSchema, ProdOrderSchema, ProductRequestSchema, PurchaseOrderSchema, RateContractSchema, RequisitionSchema, ShopAskSchema, StockRequestSchema, SupportTicketSchema, TicketSchema, VendorSchema } from "./schemas/documents.js";
import { ActivatePriceListResultSchema, AddToProcurementListBodySchema, AnswerProductRequestBodySchema, AnswerShopAskBodySchema, ApproveAdjustmentRequestResultSchema, ApproveRequestBodySchema, ApproveRequisitionBodySchema, ApprovalResultSchema, CancelPoBodySchema, CancelTicketBodySchema, CloseShortBodySchema, ContractBodySchema, CreateAdjustmentBodySchema, CreateAdjustmentRequestBodySchema, CreateItemBodySchema, CreatePoBodySchema, CreatePriceListBodySchema, CreateProductRequestBodySchema, CreateRequestBodySchema, CreateRequisitionBodySchema, DeclineRequisitionBodySchema, DeclineShopAskBodySchema, DeletedPriceListSchema, DispatchResultSchema, DistributeBodySchema, DocIdParamsSchema, HandoverBodySchema, IssueResultSchema, MakeBatchBodySchema, MenuItemBodySchema, MenuItemParamsSchema, MenuLocParamsSchema, MenuResultSchema, OutletParamsSchema, PatchContractBodySchema, PatchPoBodySchema, PatchVendorBodySchema, PayBodySchema, PoLineParamsSchema, PriceListIdParamsSchema, PriceResultSchema, RaiseTicketBodySchema, RateTicketBodySchema, DeskReplyBodySchema, ReceiptResultSchema, ReceivePoBodySchema, RedirectRequestBodySchema, RejectAdjustmentRequestBodySchema, RejectRequestBodySchema, ReplyToTicketBodySchema, SavePriceBodySchema, SavePriceParamsSchema, SetOrderStatusBodySchema, SetOutletPriceListBodySchema, SetTicketStatusBodySchema, ShopAskBodySchema, ShopAskSentResultSchema, ToggleAvailBodySchema, ToggleResultSchema, TransferBodySchema, UpdatePoLineBodySchema, VendorBodySchema, writeResponse, ItemKeyParamsSchema, ItemResultSchema, PatchItemBodySchema, SetItemImageBodySchema, BillNoParamsSchema, VoidBillBodySchema, CreateProdOrderBodySchema } from "./schemas/writes.js";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
/** "public" needs no token; "any" needs a token of any role; "admin" needs the `admin` claim
 *  (an ordinary account flagged for account management, `pnpm --filter @rch/api users
 *  set-admin` - never a role); a list names the roles whose sidebar has the module. */
export type Access = "public" | "any" | "admin" | readonly Role[];

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
  priceLists:     defineRoute({ method: "GET",   path: "/price-lists",          access: ["manager"], response: PriceListsResponseSchema }),
  menus:          defineRoute({ method: "GET",   path: "/menus",                access: "any",    response: MenusResponseSchema }),
  pay:            defineRoute({ method: "POST",   path: "/bills",                      access: ["counter"],            body: PayBodySchema,        response: writeResponse(BillSchema) }),
  // `prod` is here for the kitchen's own switch: the Central Kitchen decides what it is making
  // today, exactly as a counter decides what it is selling. Scoping is per role in the handler.
  toggleAvail:    defineRoute({ method: "POST",   path: "/availability/toggle",        access: ["counter", "manager", "prod"], body: ToggleAvailBodySchema, response: writeResponse(ToggleResultSchema) }),
  savePrice:      defineRoute({ method: "PUT",    path: "/prices/:list/:it",           access: ["manager"],            params: SavePriceParamsSchema, body: SavePriceBodySchema, response: writeResponse(PriceResultSchema) }),
  // ---- price lists ---- a list stays editable at any time, active or not, exactly like
  // `savePrice` above; these three manage the list itself: create (cloned from an outlet),
  // delete (only once no outlet points at it) and switch which list an outlet is active on.
  createPriceList:    defineRoute({ method: "POST",   path: "/price-lists",              access: ["manager"], body: CreatePriceListBodySchema, response: writeResponse(PriceListSchema) }),
  deletePriceList:    defineRoute({ method: "DELETE", path: "/price-lists/:id",          access: ["manager"], params: PriceListIdParamsSchema, response: writeResponse(DeletedPriceListSchema) }),
  setOutletPriceList: defineRoute({ method: "PUT",    path: "/outlets/:loc/price-list",  access: ["manager"], params: OutletParamsSchema, body: SetOutletPriceListBodySchema, response: writeResponse(ActivatePriceListResultSchema) }),
  addMenuItem:    defineRoute({ method: "POST",   path: "/menus/:loc/items",           access: ["manager"],            params: MenuLocParamsSchema, body: MenuItemBodySchema, response: writeResponse(MenuResultSchema) }),
  removeMenuItem: defineRoute({ method: "DELETE", path: "/menus/:loc/items/:it",       access: ["manager"],            params: MenuItemParamsSchema, response: writeResponse(MenuResultSchema) }),
  stock:          defineRoute({ method: "GET",    path: "/stock",                      access: "any",                  response: StockResponseSchema }),
  bills:          defineRoute({ method: "GET",    path: "/bills",                      access: "any",                  query: z.strictObject({ days: z.coerce.number().int().min(1).max(90).default(BILL_DAYS) }), response: BillsResponseSchema }),
  createRequest:  defineRoute({ method: "POST", path: "/requests",                  access: ["counter", "prod"],            body: CreateRequestBodySchema,   response: writeResponse(StockRequestSchema) }),
  cancelRequest:  defineRoute({ method: "POST", path: "/requests/:id/cancel",       access: ["counter", "prod", "manager"], params: DocIdParamsSchema,       response: writeResponse(StockRequestSchema) }),
  approveRequest: defineRoute({ method: "POST", path: "/requests/:id/approve",      access: ["manager"],                    params: DocIdParamsSchema, body: ApproveRequestBodySchema, response: writeResponse(ApprovalResultSchema) }),
  rejectRequest:  defineRoute({ method: "POST", path: "/requests/:id/reject",       access: ["manager"],                    params: DocIdParamsSchema, body: RejectRequestBodySchema,  response: writeResponse(StockRequestSchema) }),
  redirectRequest: defineRoute({ method: "POST", path: "/requests/:id/redirect",    access: ["manager"],                    params: DocIdParamsSchema, body: RedirectRequestBodySchema, response: writeResponse(IssueResultSchema) }),
  issueTicket:    defineRoute({ method: "POST", path: "/requests/:id/issue-ticket", access: ["store"],                      params: DocIdParamsSchema,       response: writeResponse(IssueResultSchema) }),
  // `counter` is here for a shop transfer's own ticket: the outlet that granted it
  // hands it over. No counter screen calls it yet; the route exists so Phase 6 adds a button, not a route.
  handover:       defineRoute({ method: "POST", path: "/tickets/:id/handover",      access: ["store", "prod", "counter"],   params: DocIdParamsSchema, body: HandoverBodySchema,       response: writeResponse(TicketSchema) }),
  receiveTicket:  defineRoute({ method: "POST", path: "/tickets/:id/receive",       access: ["counter", "store", "prod"],   params: DocIdParamsSchema,       response: writeResponse(TicketSchema) }),
  transfer:       defineRoute({ method: "POST", path: "/transfers",                 access: ["counter", "manager"],         body: TransferBodySchema,        response: writeResponse(TicketSchema) }),
  askShop:        defineRoute({ method: "POST", path: "/shop-asks",                 access: ["counter"],                    body: ShopAskBodySchema,         response: writeResponse(ShopAskSchema) }),
  answerShopAsk:  defineRoute({ method: "POST", path: "/shop-asks/:id/answer",      access: ["counter"],                    params: DocIdParamsSchema, body: AnswerShopAskBodySchema,  response: writeResponse(ShopAskSentResultSchema) }),
  declineShopAsk: defineRoute({ method: "POST", path: "/shop-asks/:id/decline",     access: ["counter"],                    params: DocIdParamsSchema, body: DeclineShopAskBodySchema, response: writeResponse(ShopAskSchema) }),
  dispatchProdOrder: defineRoute({ method: "POST", path: "/prod-orders/:id/dispatch", access: ["prod"], params: DocIdParamsSchema, response: writeResponse(DispatchResultSchema) }),
  distribute:        defineRoute({ method: "POST", path: "/distributions",            access: ["prod"], body: DistributeBodySchema,  response: writeResponse(TicketSchema) }),
  setOrderStatus: defineRoute({ method: "POST", path: "/prod-orders/:id/status", access: ["prod"],           params: DocIdParamsSchema, body: SetOrderStatusBodySchema, response: writeResponse(ProdOrderSchema) }),
  makeBatch:      defineRoute({ method: "POST", path: "/batches",                access: ["prod"],           body: MakeBatchBodySchema,                                 response: writeResponse(BatchSchema) }),
  // The store cancels the store's tickets, the kitchen the kitchen's, and - from Phase 6 - an
  // outlet its own: a shop transfer and a granted shop ask both leave from an outlet, and until
  // now `requireLocOf` on the ticket's `from` put them out of everyone's reach rather than into
  // the counter's. The scoping is unchanged; only the door is wider.
  cancelTicket:   defineRoute({ method: "POST", path: "/tickets/:id/cancel",     access: ["store", "prod", "counter"],  params: DocIdParamsSchema, body: CancelTicketBodySchema,   response: writeResponse(TicketSchema) }),
  // ---- Buying. The store keeper asks, the buyer decides and orders, and
  // either of them books the goods in. Reads are declared beside their handlers, further down.
  createRequisition:    defineRoute({ method: "POST",   path: "/requisitions",                  access: ["store"],            body: CreateRequisitionBodySchema,  response: writeResponse(RequisitionSchema) }),
  approveRequisition:   defineRoute({ method: "POST",   path: "/requisitions/:id/approve",      access: ["buyer"],            params: DocIdParamsSchema, body: ApproveRequisitionBodySchema, response: writeResponse(RequisitionSchema) }),
  declineRequisition:   defineRoute({ method: "POST",   path: "/requisitions/:id/decline",      access: ["buyer"],            params: DocIdParamsSchema, body: DeclineRequisitionBodySchema, response: writeResponse(RequisitionSchema) }),
  // The buyer's own addition to the procurement list: a requisition raised and approved in one
  // step, so every purchase order, receipt and shortfall still claims against a requisition line.
  addToProcurementList: defineRoute({ method: "POST",   path: "/requisitions/direct",           access: ["buyer"],            body: AddToProcurementListBodySchema, response: writeResponse(RequisitionSchema) }),
  createPo:             defineRoute({ method: "POST",   path: "/purchase-orders",               access: ["buyer"],            body: CreatePoBodySchema,           response: writeResponse(PurchaseOrderSchema) }),
  updatePoLine:         defineRoute({ method: "PATCH",  path: "/purchase-orders/:id/lines/:n",  access: ["buyer"],            params: PoLineParamsSchema, body: UpdatePoLineBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  removePoLine:         defineRoute({ method: "DELETE", path: "/purchase-orders/:id/lines/:n",  access: ["buyer"],            params: PoLineParamsSchema,         response: writeResponse(PurchaseOrderSchema) }),
  patchPo:              defineRoute({ method: "PATCH",  path: "/purchase-orders/:id",           access: ["buyer"],            params: DocIdParamsSchema, body: PatchPoBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  sendPo:               defineRoute({ method: "POST",   path: "/purchase-orders/:id/send",      access: ["buyer"],            params: DocIdParamsSchema,          response: writeResponse(PurchaseOrderSchema) }),
  cancelPo:             defineRoute({ method: "POST",   path: "/purchase-orders/:id/cancel",    access: ["buyer"],            params: DocIdParamsSchema, body: CancelPoBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  // The buyer receives against the order they raised; the store keeper receives at the door.
  receivePo:            defineRoute({ method: "POST",   path: "/purchase-orders/:id/receive",   access: ["buyer", "store"],   params: DocIdParamsSchema, body: ReceivePoBodySchema, response: writeResponse(ReceiptResultSchema) }),
  closePoShort:         defineRoute({ method: "POST",   path: "/purchase-orders/:id/close-short", access: ["buyer"],          params: DocIdParamsSchema, body: CloseShortBodySchema, response: writeResponse(PurchaseOrderSchema) }),
  addVendor:            defineRoute({ method: "POST",   path: "/vendors",                       access: ["buyer"],            body: VendorBodySchema,             response: writeResponse(VendorSchema) }),
  // One PATCH for both the edit and the on/off switch: `setVendorActive` is a patch of one field.
  updateVendor:         defineRoute({ method: "PATCH",  path: "/vendors/:id",                   access: ["buyer"],            params: DocIdParamsSchema, body: PatchVendorBodySchema, response: writeResponse(VendorSchema) }),
  addContract:          defineRoute({ method: "POST",   path: "/contracts",                     access: ["buyer"],            body: ContractBodySchema,           response: writeResponse(RateContractSchema) }),
  updateContract:       defineRoute({ method: "PATCH",  path: "/contracts/:id",                 access: ["buyer"],            params: DocIdParamsSchema, body: PatchContractBodySchema, response: writeResponse(RateContractSchema) }),
  removeContract:       defineRoute({ method: "DELETE", path: "/contracts/:id",                 access: ["buyer"],            params: DocIdParamsSchema,          response: writeResponse(RateContractSchema) }),
  // Three screens add a product: the kitchen's own (FG and RAW, at the kitchen), the store's,
  // and the buyer's answer to a shop's request.
  createItem:           defineRoute({ method: "POST",   path: "/items",                         access: ["store", "prod", "buyer"], body: CreateItemBodySchema,   response: writeResponse(ItemResultSchema) }),
  createProductRequest: defineRoute({ method: "POST",   path: "/product-requests",              access: ["counter", "manager"], body: CreateProductRequestBodySchema, response: writeResponse(ProductRequestSchema) }),
  answerProductRequest: defineRoute({ method: "POST",   path: "/product-requests/:id/answer",   access: ["store", "buyer"],   params: DocIdParamsSchema, body: AnswerProductRequestBodySchema, response: writeResponse(ProductRequestSchema) }),
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
  stockLedger:  defineRoute({ method: "GET", path: "/reports/stock-ledger",     access: ["store", "manager", "buyer", "prod"], query: StockLedgerQuerySchema, response: StockLedgerResponseSchema }),
  creditReport: defineRoute({ method: "GET", path: "/reports/credit/:kind/:id", access: ["counter", "manager"],                params: CreditParamsSchema,   response: CreditResponseSchema }),
  // ---- the register. An X changes nothing and may be taken as often as anyone likes, so it is a
  // GET; a Z closes the outlet's session and opens the next, so it is a write and carries an
  // Idempotency-Key like every other write - a retried close must replay its Z, never mint a
  // second one. Both are open to the counter and the manager: closing the day is the consultant's
  // own act, and the manager can do it for any outlet.
  xReport:      defineRoute({ method: "GET",  path: "/register/x",          access: ["counter", "manager"], query: RegisterQuerySchema,     response: RegisterReportSchema }),
  closeRegister:defineRoute({ method: "POST", path: "/register/close",      access: ["counter", "manager"], body: CloseRegisterBodySchema,  response: writeResponse(RegisterReportSchema) }),
  zReports:     defineRoute({ method: "GET",  path: "/register/z",          access: ["counter", "manager"], query: ZReportsQuerySchema,     response: RegisterReportsResponseSchema }),
  // ---- payers (the roster behind every non-cash tender). The register itself is the super
  // admin's (`/admin/payers`, below); the CSV import stays for a ward list nobody types twice.
  // `GET /roster` is the till's read, live payers only, "any" and scoped like the snapshot's own
  // copy: a caller who never opens a payer picker reads an empty register.
  roster: defineRoute({ method: "GET", path: "/roster", access: "any", response: RosterResponseSchema }),
  // ---- what each party is charged, and what they owe.
  //
  // `GET /payer-terms` is "any" and scoped empty for the three desks that never take a bill,
  // exactly like the roster above. That is deliberate rather than tidy: a manager's write
  // announces "terms" to *every* open browser, and a route the store keeper's tab is forbidden
  // would fail that tab's whole refetch with a toast about a screen of theirs that never changed.
  // The four writes are the outlet manager's alone.
  payerTerms:      defineRoute({ method: "GET", path: "/payer-terms",             access: "any",       response: TermsResponseSchema }),
  setClassTerms:   defineRoute({ method: "PUT", path: "/payer-terms/class/:cls",  access: ["manager"], params: ClassParamsSchema, body: SetClassTermsBodySchema, response: writeResponse(ClassTermsSchema) }),
  setPayerTerms:   defineRoute({ method: "PUT", path: "/payer-terms/:kind/:id",   access: ["manager"], params: PayerParamsSchema, body: SetPayerTermsBodySchema, response: writeResponse(PayerTermsSchema) }),
  // The two lists behind the manager's Credit screen are "any" and answer `[]` to everybody
  // else, for the same reason `/roster` and `/payer-terms` are: a settlement announces
  // "receivables" to every open browser, and a route a store keeper's tab is forbidden would
  // fail that tab's whole refetch over a screen of theirs that never changed. The service
  // short-circuits before it queries anything, so an empty answer costs nothing.
  receivables:     defineRoute({ method: "GET", path: "/receivables",             access: "any",       response: ReceivablesResponseSchema }),
  settlements:     defineRoute({ method: "GET", path: "/settlements",             access: "any",       response: SettlementsResponseSchema }),
  // One party's statement is opened by hand from a drawer and is never in a `changed`, so it can
  // stay closed to everyone but the manager.
  statement:       defineRoute({ method: "GET", path: "/receivables/:kind/:id",   access: ["manager"], params: PayerParamsSchema, response: StatementSchema }),
  recordSettlement: defineRoute({ method: "POST", path: "/settlements",           access: ["manager"], body: RecordSettlementBodySchema, response: writeResponse(SettlementSchema) }),
  voidSettlement:  defineRoute({ method: "POST", path: "/settlements/:id/void",   access: ["manager"], params: SettlementIdParamsSchema, body: VoidSettlementBodySchema, response: writeResponse(SettlementSchema) }),
  // ---- item patch ----
  // The item master stopped being write-once. All four desks that handle goods reach this door;
  // which of the eight fields each of them may actually move is `ITEM_FIELD_ROLES`
  // (`@rch/domain`), refused in the service with a sentence naming whose field it is. The counter
  // is absent for the same reason it is absent from `POST /items`: a till sells the master.
  patchItem:    defineRoute({ method: "PATCH", path: "/items/:it", access: ["manager", "store", "buyer", "prod"], params: ItemKeyParamsSchema, body: PatchItemBodySchema, response: writeResponse(ItemResultSchema) }),
  // ---- item photos ----
  // The manager for any item, a counter for what its own outlet lists (the service's rule, a
  // 403 naming the outlet). The photo itself is read at `ITEM_IMAGE_PATH`, outside the manifest.
  setItemImage:    defineRoute({ method: "PUT",    path: "/items/:it/image", access: ["manager", "counter"], params: ItemKeyParamsSchema, body: SetItemImageBodySchema, response: writeResponse(ItemResultSchema) }),
  removeItemImage: defineRoute({ method: "DELETE", path: "/items/:it/image", access: ["manager", "counter"], params: ItemKeyParamsSchema, response: writeResponse(ItemResultSchema) }),
  // ---- bill void. The manager's door, and only the manager's: a till that could unsell its own
  // takings is not a till anybody reconciles. Same IST day is the service's rule, so a bill from
  // yesterday reads a sentence naming the day it belongs to rather than a missing button.
  // `:no` is a bill number and carries a slash, so it arrives percent-encoded (`CF%2F1188`).
  voidBill:     defineRoute({ method: "POST", path: "/bills/:no/void",            access: ["manager"],                          params: BillNoParamsSchema, body: VoidBillBodySchema, response: writeResponse(BillSchema) }),
  // ---- adjustments. A write-off or a count-up as a document, with a reason and a signature -
  // the store keeper and the kitchen correct their own shelves directly. An outlet's is the one
  // exception: the manager no longer adjusts it directly, only through the request pair below,
  // which is why "manager" is not in this list.
  createAdjustment: defineRoute({ method: "POST", path: "/adjustments", access: ["store", "prod"], body: CreateAdjustmentBodySchema, response: writeResponse(AdjustmentSchema) }),
  adjustments:      defineRoute({ method: "GET",  path: "/adjustments", access: "any",             response: AdjustmentsResponseSchema }),
  // ---- adjustment requests. A counter's ask to correct its own shelf, which the outlet manager
  // approves (writing the `ADJ-` document in the same step) or rejects. There is no issue-ticket
  // stage after "Approved" - a write-off has no hand-off to scan, so approving one is the whole
  // of the movement.
  createAdjustmentRequest:  defineRoute({ method: "POST", path: "/adjustment-requests",            access: ["counter"],            body: CreateAdjustmentRequestBodySchema, response: writeResponse(AdjustmentRequestSchema) }),
  cancelAdjustmentRequest:  defineRoute({ method: "POST", path: "/adjustment-requests/:id/cancel",  access: ["counter", "manager"], params: DocIdParamsSchema, response: writeResponse(AdjustmentRequestSchema) }),
  approveAdjustmentRequest: defineRoute({ method: "POST", path: "/adjustment-requests/:id/approve", access: ["manager"],            params: DocIdParamsSchema, response: writeResponse(ApproveAdjustmentRequestResultSchema) }),
  rejectAdjustmentRequest:  defineRoute({ method: "POST", path: "/adjustment-requests/:id/reject",  access: ["manager"],            params: DocIdParamsSchema, body: RejectAdjustmentRequestBodySchema, response: writeResponse(AdjustmentRequestSchema) }),
  adjustmentRequests:       defineRoute({ method: "GET",  path: "/adjustment-requests",             access: "any",                  response: AdjustmentRequestsResponseSchema }),
  // ---- prod-order raise ---- the other end of the kitchen's board. `dispatch` and the board's
  // statuses act on orders nobody could raise; this is how one arrives. A counter raises for its
  // own outlet (the route pins `from` to the token) and the manager raises for any of the three,
  // naming it - the same split `createRequest` and `approveRequest` already draw between a desk
  // that owns one location and a role that supervises them all.
  createProdOrder: defineRoute({ method: "POST", path: "/prod-orders", access: ["counter", "manager"], body: CreateProdOrderBodySchema, response: writeResponse(ProdOrderSchema) }),
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
  // in-patients - opened, renamed and switched off here. There is no delete: a payer with a bill
  // against them is somebody's balance, and an id that vanishes is a debt nobody can find. What
  // each of them is charged is the outlet manager's, at `/payer-terms` above.
  adminPayers:           defineRoute({ method: "GET",   path: "/admin/payers",                     access: "admin", response: z.array(AdminPayerSchema) }),
  createPayer:           defineRoute({ method: "POST",  path: "/admin/payers",                     access: "admin", body: CreatePayerBodySchema, response: writeResponse(AdminPayerSchema) }),
  updatePayer:           defineRoute({ method: "PATCH", path: "/admin/payers/:kind/:id",           access: "admin", params: AdminPayerParamsSchema, body: UpdatePayerBodySchema, response: writeResponse(AdminPayerSchema) }),
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
