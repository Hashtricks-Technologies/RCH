import { z } from "zod";
import type { Role } from "./types.js";
import { OkResponseSchema } from "./schemas/common.js";
import { AuthResponseSchema, ChangePasswordBodySchema, LoginBodySchema, MeResponseSchema, PatchMeBodySchema } from "./schemas/auth.js";
import { AdjustmentsResponseSchema, BatchesResponseSchema, BILL_DAYS, BillsResponseSchema, ContractsResponseSchema, GrnsResponseSchema, ItemsResponseSchema, LocationsResponseSchema, MenusResponseSchema, PricesResponseSchema, ProdOrdersResponseSchema, ProductRequestsResponseSchema, PurchaseOrdersResponseSchema, RecipesResponseSchema, RequestsResponseSchema, PayersResponseSchema, RequisitionsResponseSchema, RosterResponseSchema, ShopAsksResponseSchema, SnapshotSchema, StockResponseSchema, SupportTicketsResponseSchema, TicketsResponseSchema, VendorsResponseSchema } from "./schemas/snapshot.js";
import { CreditParamsSchema, CreditResponseSchema, StockLedgerQuerySchema, StockLedgerResponseSchema } from "./schemas/reports.js";
import { AdminActionSchema, AdminUserIdParamsSchema, AdminUserSchema, AdminUserWithTempPasswordSchema, CreateAdminUserBodySchema, UpdateAdminUserBodySchema } from "./schemas/admin.js";
import { RecipeResultSchema, SaveRecipeBodySchema } from "./schemas/recipes.js";
import { AdjustmentSchema, BatchSchema, BillSchema, PayerRecordSchema, ProdOrderSchema, ProductRequestSchema, PurchaseOrderSchema, RateContractSchema, RequisitionSchema, ShopAskSchema, StockRequestSchema, SupportTicketSchema, TicketSchema, VendorSchema } from "./schemas/documents.js";
import { AnswerProductRequestBodySchema, AnswerShopAskBodySchema, ApproveRequestBodySchema, ApproveRequisitionBodySchema, ApprovalResultSchema, CancelPoBodySchema, CancelTicketBodySchema, CloseShortBodySchema, ContractBodySchema, CreateAdjustmentBodySchema, CreateItemBodySchema, CreatePoBodySchema, CreateProductRequestBodySchema, CreateRequestBodySchema, CreateRequisitionBodySchema, DeclineRequisitionBodySchema, DeclineShopAskBodySchema, DispatchResultSchema, DistributeBodySchema, DocIdParamsSchema, HandoverBodySchema, IssueResultSchema, MakeBatchBodySchema, MenuItemBodySchema, MenuItemParamsSchema, MenuLocParamsSchema, MenuResultSchema, PatchContractBodySchema, PatchPoBodySchema, PatchVendorBodySchema, PatchPayerBodySchema, PayBodySchema, PayerBodySchema, PayerParamsSchema, PoLineParamsSchema, PriceResultSchema, RaiseTicketBodySchema, RateTicketBodySchema, ReceiptResultSchema, ReceivePoBodySchema, RejectRequestBodySchema, ReplyToTicketBodySchema, SavePriceBodySchema, SavePriceParamsSchema, SetOrderStatusBodySchema, SetTicketStatusBodySchema, ShopAskBodySchema, ShopAskSentResultSchema, ToggleAvailBodySchema, ToggleResultSchema, TransferBodySchema, UpdatePoLineBodySchema, VendorBodySchema, writeResponse, ItemKeyParamsSchema, ItemResultSchema, PatchItemBodySchema, BillNoParamsSchema, VoidBillBodySchema, CreateProdOrderBodySchema } from "./schemas/writes.js";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
/** "public" needs no token; "any" needs a token of any role; "admin" needs the `admin` claim
 *  (an ordinary account flagged for account management, `pnpm --filter @rch/api users
 *  set-admin` — never a role); a list names the roles whose sidebar has the module. */
export type Access = "public" | "any" | "admin" | readonly Role[];

export interface Route<P extends z.ZodTypeAny, Q extends z.ZodTypeAny, B extends z.ZodTypeAny, R extends z.ZodTypeAny> {
  method: Method; path: string; access: Access;
  params?: P; query?: Q; body?: B; response: R;
  /** Writes require an Idempotency-Key header (Task 10). Defaults to method !== "GET". */
  write?: boolean;
  /** Reachable while must_change_password is set. Only auth and /me. */
  allowMcp?: boolean;
}
export type AnyRoute = Route<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>;
export const defineRoute = <P extends z.ZodTypeAny = z.ZodNever, Q extends z.ZodTypeAny = z.ZodNever, B extends z.ZodTypeAny = z.ZodNever, R extends z.ZodTypeAny = z.ZodTypeAny>(r: Route<P, Q, B, R>) => r;

export const routes = {
  login:          defineRoute({ method: "POST",  path: "/auth/login",           access: "public", body: LoginBodySchema, response: AuthResponseSchema, write: false, allowMcp: true }),
  refresh:        defineRoute({ method: "POST",  path: "/auth/refresh",         access: "public", response: AuthResponseSchema, write: false, allowMcp: true }),
  logout:         defineRoute({ method: "POST",  path: "/auth/logout",          access: "public", response: OkResponseSchema, write: false, allowMcp: true }),
  changePassword: defineRoute({ method: "POST",  path: "/auth/change-password", access: "any",    body: ChangePasswordBodySchema, response: AuthResponseSchema, write: false, allowMcp: true }),
  me:             defineRoute({ method: "GET",   path: "/me",                   access: "any",    response: MeResponseSchema, allowMcp: true }),
  patchMe:        defineRoute({ method: "PATCH", path: "/me",                   access: "any",    body: PatchMeBodySchema, response: MeResponseSchema, allowMcp: true }),
  snapshot:       defineRoute({ method: "GET",   path: "/snapshot",             access: "any",    response: SnapshotSchema }),
  items:          defineRoute({ method: "GET",   path: "/items",                access: "any",    response: ItemsResponseSchema }),
  locations:      defineRoute({ method: "GET",   path: "/locations",            access: "any",    response: LocationsResponseSchema }),
  recipes:        defineRoute({ method: "GET",   path: "/recipes",              access: "any",    response: RecipesResponseSchema }),
  prices:         defineRoute({ method: "GET",   path: "/prices",               access: "any",    response: PricesResponseSchema }),
  menus:          defineRoute({ method: "GET",   path: "/menus",                access: "any",    response: MenusResponseSchema }),
  pay:            defineRoute({ method: "POST",   path: "/bills",                      access: ["counter"],            body: PayBodySchema,        response: writeResponse(BillSchema) }),
  // `prod` is here for the kitchen's own switch: the Central Kitchen decides what it is making
  // today, exactly as a counter decides what it is selling. Scoping is per role in the handler.
  toggleAvail:    defineRoute({ method: "POST",   path: "/availability/toggle",        access: ["counter", "manager", "prod"], body: ToggleAvailBodySchema, response: writeResponse(ToggleResultSchema) }),
  savePrice:      defineRoute({ method: "PUT",    path: "/prices/:list/:it",           access: ["manager"],            params: SavePriceParamsSchema, body: SavePriceBodySchema, response: writeResponse(PriceResultSchema) }),
  addMenuItem:    defineRoute({ method: "POST",   path: "/menus/:loc/items",           access: ["manager"],            params: MenuLocParamsSchema, body: MenuItemBodySchema, response: writeResponse(MenuResultSchema) }),
  removeMenuItem: defineRoute({ method: "DELETE", path: "/menus/:loc/items/:it",       access: ["manager"],            params: MenuItemParamsSchema, response: writeResponse(MenuResultSchema) }),
  stock:          defineRoute({ method: "GET",    path: "/stock",                      access: "any",                  response: StockResponseSchema }),
  bills:          defineRoute({ method: "GET",    path: "/bills",                      access: "any",                  query: z.strictObject({ days: z.coerce.number().int().min(1).max(90).default(BILL_DAYS) }), response: BillsResponseSchema }),
  createRequest:  defineRoute({ method: "POST", path: "/requests",                  access: ["counter", "prod"],            body: CreateRequestBodySchema,   response: writeResponse(StockRequestSchema) }),
  cancelRequest:  defineRoute({ method: "POST", path: "/requests/:id/cancel",       access: ["counter", "prod", "manager"], params: DocIdParamsSchema,       response: writeResponse(StockRequestSchema) }),
  approveRequest: defineRoute({ method: "POST", path: "/requests/:id/approve",      access: ["manager"],                    params: DocIdParamsSchema, body: ApproveRequestBodySchema, response: writeResponse(ApprovalResultSchema) }),
  rejectRequest:  defineRoute({ method: "POST", path: "/requests/:id/reject",       access: ["manager"],                    params: DocIdParamsSchema, body: RejectRequestBodySchema,  response: writeResponse(StockRequestSchema) }),
  issueTicket:    defineRoute({ method: "POST", path: "/requests/:id/issue-ticket", access: ["store"],                      params: DocIdParamsSchema,       response: writeResponse(IssueResultSchema) }),
  // `counter` is here for a shop transfer's own ticket (spec §9.2): the outlet that granted it
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
  // The store cancels the store's tickets, the kitchen the kitchen's, and — from Phase 6 — an
  // outlet its own: a shop transfer and a granted shop ask both leave from an outlet, and until
  // now `requireLocOf` on the ticket's `from` put them out of everyone's reach rather than into
  // the counter's. The scoping is unchanged; only the door is wider.
  cancelTicket:   defineRoute({ method: "POST", path: "/tickets/:id/cancel",     access: ["store", "prod", "counter"],  params: DocIdParamsSchema, body: CancelTicketBodySchema,   response: writeResponse(TicketSchema) }),
  // ---- Buying (spec §9.2, Phase 5). The store keeper asks, the buyer decides and orders, and
  // either of them books the goods in. Reads are declared beside their handlers, further down.
  createRequisition:    defineRoute({ method: "POST",   path: "/requisitions",                  access: ["store"],            body: CreateRequisitionBodySchema,  response: writeResponse(RequisitionSchema) }),
  approveRequisition:   defineRoute({ method: "POST",   path: "/requisitions/:id/approve",      access: ["buyer"],            params: DocIdParamsSchema, body: ApproveRequisitionBodySchema, response: writeResponse(RequisitionSchema) }),
  declineRequisition:   defineRoute({ method: "POST",   path: "/requisitions/:id/decline",      access: ["buyer"],            params: DocIdParamsSchema, body: DeclineRequisitionBodySchema, response: writeResponse(RequisitionSchema) }),
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
  addContract:          defineRoute({ method: "POST",   path: "/contracts",                     access: ["store"],            body: ContractBodySchema,           response: writeResponse(RateContractSchema) }),
  updateContract:       defineRoute({ method: "PATCH",  path: "/contracts/:id",                 access: ["store"],            params: DocIdParamsSchema, body: PatchContractBodySchema, response: writeResponse(RateContractSchema) }),
  removeContract:       defineRoute({ method: "DELETE", path: "/contracts/:id",                 access: ["store"],            params: DocIdParamsSchema,          response: writeResponse(RateContractSchema) }),
  // Three screens add a product: the kitchen's own (FG and RAW, at the kitchen), the store's,
  // and the buyer's answer to a shop's request. §8.3 named only the store keeper; §16 records it.
  createItem:           defineRoute({ method: "POST",   path: "/items",                         access: ["store", "prod", "buyer"], body: CreateItemBodySchema,   response: writeResponse(ItemResultSchema) }),
  createProductRequest: defineRoute({ method: "POST",   path: "/product-requests",              access: ["counter", "manager"], body: CreateProductRequestBodySchema, response: writeResponse(ProductRequestSchema) }),
  answerProductRequest: defineRoute({ method: "POST",   path: "/product-requests/:id/answer",   access: ["store", "buyer"],   params: DocIdParamsSchema, body: AnswerProductRequestBodySchema, response: writeResponse(ProductRequestSchema) }),
  // The five movement collections, each on its own, so a write that names "req", "tkt",
  // "shopAsks", "pord" or "batch" in `changed` refetches that slice and not the whole snapshot.
  // `ticketsList` rather than `tickets`, because `tickets` is the support-ticket collection and
  // will be the Phase 6 route name — two manifest keys must not collide.
  requests:    defineRoute({ method: "GET", path: "/requests",   access: "any", response: RequestsResponseSchema }),
  ticketsList: defineRoute({ method: "GET", path: "/tickets",    access: "any", response: TicketsResponseSchema }),
  shopAsks:    defineRoute({ method: "GET", path: "/shop-asks",  access: "any", response: ShopAsksResponseSchema }),
  // The kitchen's two collections, likewise: a make names "batch" and "stock", a status change
  // names "pord", and each refetches its own slice instead of the whole snapshot (spec §9.1).
  prodOrders:  defineRoute({ method: "GET", path: "/prod-orders", access: "any", response: ProdOrdersResponseSchema }),
  batches:     defineRoute({ method: "GET", path: "/batches",     access: "any", response: BatchesResponseSchema }),
  // Buying's six, each answering for one slice a write can name in `changed` (spec §9.1).
  requisitions:    defineRoute({ method: "GET", path: "/requisitions",     access: "any", response: RequisitionsResponseSchema }),
  purchaseOrders:  defineRoute({ method: "GET", path: "/purchase-orders",  access: "any", response: PurchaseOrdersResponseSchema }),
  grns:            defineRoute({ method: "GET", path: "/grns",             access: "any", response: GrnsResponseSchema }),
  vendors:         defineRoute({ method: "GET", path: "/vendors",          access: "any", response: VendorsResponseSchema }),
  contracts:       defineRoute({ method: "GET", path: "/contracts",        access: "any", response: ContractsResponseSchema }),
  productRequests: defineRoute({ method: "GET", path: "/product-requests", access: "any", response: ProductRequestsResponseSchema }),
  // ---- The support desk (spec §9.2, Phase 6). Every role, own tickets only: `access: "any"`
  // opens the module to all five, and the service scopes each row on `by_user = claims.sub`.
  // A ticket somebody else raised is a 404, not a 403 — the same shape as a role's missing module.
  raiseTicket:     defineRoute({ method: "POST", path: "/support/tickets",              access: "any", body: RaiseTicketBodySchema,     response: writeResponse(SupportTicketSchema) }),
  replyToTicket:   defineRoute({ method: "POST", path: "/support/tickets/:id/messages", access: "any", params: DocIdParamsSchema, body: ReplyToTicketBodySchema,   response: writeResponse(SupportTicketSchema) }),
  setTicketStatus: defineRoute({ method: "POST", path: "/support/tickets/:id/status",   access: "any", params: DocIdParamsSchema, body: SetTicketStatusBodySchema, response: writeResponse(SupportTicketSchema) }),
  rateTicket:      defineRoute({ method: "POST", path: "/support/tickets/:id/rating",   access: "any", params: DocIdParamsSchema, body: RateTicketBodySchema,      response: writeResponse(SupportTicketSchema) }),
  // `tickets`, not `supportTickets`: the name was reserved for this route when `ticketsList`
  // was named, so the manifest key matches the `changed` collection the writes above name.
  tickets:         defineRoute({ method: "GET",  path: "/support/tickets",              access: "any", response: SupportTicketsResponseSchema }),
  // ---- Reports (spec §9.1, Phase 6). Two figures a caller cannot compute from its own snapshot:
  // the ledger, which needs `stock_moves` and which the browser had to reconstruct backwards from
  // receipts and issues, and a payer's credit for the calendar month, which needs every outlet's
  // bills and which the till could only approximate from its own seven days. Every other report
  // and every dashboard reads a slice the snapshot already carries whole and stays in the browser.
  stockLedger:  defineRoute({ method: "GET", path: "/reports/stock-ledger",     access: ["store", "manager", "buyer", "prod"], query: StockLedgerQuerySchema, response: StockLedgerResponseSchema }),
  creditReport: defineRoute({ method: "GET", path: "/reports/credit/:kind/:id", access: ["counter", "manager"],                params: CreditParamsSchema,   response: CreditResponseSchema }),
  // ---- payers (the roster behind every non-cash tender). The outlet manager keeps the
  // register: `POST /payers` puts a patient, a staff member or a department on it, and the one
  // PATCH covers both the rename and the on/off switch — a payer is never deleted, because the
  // bills already posted to them have to stay readable. `GET /roster` is "any" and scoped like
  // the snapshot's own copy: a caller who never opens a payer picker reads an empty register.
  addPayer:    defineRoute({ method: "POST",  path: "/payers",            access: ["manager"], body: PayerBodySchema,   response: writeResponse(PayerRecordSchema) }),
  updatePayer: defineRoute({ method: "PATCH", path: "/payers/:kind/:id",  access: ["manager"], params: PayerParamsSchema, body: PatchPayerBodySchema, response: writeResponse(PayerRecordSchema) }),
  roster:      defineRoute({ method: "GET",   path: "/roster",            access: "any",       response: RosterResponseSchema }),
  // The register whole, closed accounts included, for the role that keeps it — `/roster` is the
  // till's read and stops at the live rows, so without this a payer switched off last week is
  // one nobody can reopen. Both payer writes name **both** collections in `changed`.
  payers:      defineRoute({ method: "GET",   path: "/payers",            access: ["manager"], response: PayersResponseSchema }),
  // ---- item patch ----
  // The item master stopped being write-once. All four desks that handle goods reach this door;
  // which of the eight fields each of them may actually move is `ITEM_FIELD_ROLES`
  // (`@rch/domain`), refused in the service with a sentence naming whose field it is. The counter
  // is absent for the same reason it is absent from `POST /items`: a till sells the master.
  patchItem:    defineRoute({ method: "PATCH", path: "/items/:it", access: ["manager", "store", "buyer", "prod"], params: ItemKeyParamsSchema, body: PatchItemBodySchema, response: writeResponse(ItemResultSchema) }),
  // ---- bill void. The manager's door, and only the manager's: a till that could unsell its own
  // takings is not a till anybody reconciles. Same IST day is the service's rule, so a bill from
  // yesterday reads a sentence naming the day it belongs to rather than a missing button.
  // `:no` is a bill number and carries a slash, so it arrives percent-encoded (`CF%2F1188`).
  voidBill:     defineRoute({ method: "POST", path: "/bills/:no/void",            access: ["manager"],                          params: BillNoParamsSchema, body: VoidBillBodySchema, response: writeResponse(BillSchema) }),
  // ---- adjustments. A write-off or a count-up as a document, with a reason and a signature —
  // the three roles that hold stock they are answerable for. The scope of each is decided in the
  // handler, not here: the store keeper corrects any shelf including quarantine, a manager only
  // an outlet, and the kitchen only the kitchen.
  createAdjustment: defineRoute({ method: "POST", path: "/adjustments", access: ["store", "manager", "prod"], body: CreateAdjustmentBodySchema, response: writeResponse(AdjustmentSchema) }),
  adjustments:      defineRoute({ method: "GET",  path: "/adjustments", access: "any",                        response: AdjustmentsResponseSchema }),
  // ---- prod-order raise ---- the other end of the kitchen's board. `dispatch` and the board's
  // statuses act on orders nobody could raise; this is how one arrives. A counter raises for its
  // own outlet (the route pins `from` to the token) and the manager raises for any of the three,
  // naming it — the same split `createRequest` and `approveRequest` already draw between a desk
  // that owns one location and a role that supervises them all.
  createProdOrder: defineRoute({ method: "POST", path: "/prod-orders", access: ["counter", "manager"], body: CreateProdOrderBodySchema, response: writeResponse(ProdOrderSchema) }),
  // ---- admin: account management. A capability, not a role — `access: "admin"` checks the
  // `admin` claim (root CLAUDE.md), never `req.user.role`, so every one of these is reachable
  // from an ordinary account of any role that has been flagged, and from none that has not.
  // Granting or revoking the flag itself is not among them (§7 of the design): there is no
  // route here for it, only `pnpm --filter @rch/api users set-admin`.
  adminUsers:            defineRoute({ method: "GET",   path: "/admin/users",                     access: "admin", response: z.array(AdminUserSchema) }),
  createAdminUser:       defineRoute({ method: "POST",  path: "/admin/users",                      access: "admin", body: CreateAdminUserBodySchema, response: writeResponse(AdminUserWithTempPasswordSchema) }),
  resetAdminUserPassword: defineRoute({ method: "POST", path: "/admin/users/:id/reset-password",   access: "admin", params: AdminUserIdParamsSchema, response: writeResponse(AdminUserWithTempPasswordSchema) }),
  deactivateAdminUser:   defineRoute({ method: "POST",  path: "/admin/users/:id/deactivate",       access: "admin", params: AdminUserIdParamsSchema, response: writeResponse(AdminUserSchema) }),
  reactivateAdminUser:   defineRoute({ method: "POST",  path: "/admin/users/:id/reactivate",       access: "admin", params: AdminUserIdParamsSchema, response: writeResponse(AdminUserSchema) }),
  updateAdminUser:       defineRoute({ method: "PATCH", path: "/admin/users/:id",                  access: "admin", params: AdminUserIdParamsSchema, body: UpdateAdminUserBodySchema, response: writeResponse(AdminUserSchema) }),
  adminActions:          defineRoute({ method: "GET",   path: "/admin/actions",                    access: "admin", response: z.array(AdminActionSchema) }),
  // ---- recipes. An item's whole recipe, replaced in one write — the kitchen that makes from it
  // and the manager who prices against it. Until this door existed a recipe could only arrive with
  // the seed, so a hospital started clean could list a made-to-order item and never sell one.
  saveRecipe: defineRoute({ method: "PUT", path: "/recipes/:it", access: ["prod", "manager"], params: ItemKeyParamsSchema, body: SaveRecipeBodySchema, response: writeResponse(RecipeResultSchema) }),
} as const;
export type RouteName = keyof typeof routes;
export const API_PREFIX = "/api/v1";
