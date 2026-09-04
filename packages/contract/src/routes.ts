import { z } from "zod";
import type { Role } from "./types.js";
import { OkResponseSchema } from "./schemas/common.js";
import { AuthResponseSchema, ChangePasswordBodySchema, LoginBodySchema, MeResponseSchema, PatchMeBodySchema } from "./schemas/auth.js";
import { BatchesResponseSchema, BILL_DAYS, BillsResponseSchema, ItemsResponseSchema, LocationsResponseSchema, MenusResponseSchema, PricesResponseSchema, ProdOrdersResponseSchema, RecipesResponseSchema, RequestsResponseSchema, ShopAsksResponseSchema, SnapshotSchema, StockResponseSchema, TicketsResponseSchema } from "./schemas/snapshot.js";
import { BatchSchema, BillSchema, ProdOrderSchema, ProductRequestSchema, PurchaseOrderSchema, RateContractSchema, RequisitionSchema, ShopAskSchema, StockRequestSchema, TicketSchema, VendorSchema } from "./schemas/documents.js";
import { AnswerProductRequestBodySchema, AnswerShopAskBodySchema, ApproveRequestBodySchema, ApproveRequisitionBodySchema, ApprovalResultSchema, CancelPoBodySchema, CancelTicketBodySchema, CloseShortBodySchema, ContractBodySchema, CreateItemBodySchema, CreatePoBodySchema, CreateProductRequestBodySchema, CreateRequestBodySchema, CreateRequisitionBodySchema, DeclineRequisitionBodySchema, DeclineShopAskBodySchema, DispatchResultSchema, DistributeBodySchema, DocIdParamsSchema, HandoverBodySchema, IssueResultSchema, MakeBatchBodySchema, MenuItemBodySchema, MenuItemParamsSchema, MenuLocParamsSchema, MenuResultSchema, NewItemResultSchema, PatchContractBodySchema, PatchPoBodySchema, PatchVendorBodySchema, PayBodySchema, PoLineParamsSchema, PriceResultSchema, ReceiptResultSchema, ReceivePoBodySchema, RejectRequestBodySchema, SavePriceBodySchema, SavePriceParamsSchema, SetOrderStatusBodySchema, ShopAskBodySchema, ShopAskSentResultSchema, ToggleAvailBodySchema, ToggleResultSchema, TransferBodySchema, UpdatePoLineBodySchema, VendorBodySchema, writeResponse } from "./schemas/writes.js";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
/** "public" needs no token; "any" needs a token of any role; a list names the roles whose sidebar has the module. */
export type Access = "public" | "any" | readonly Role[];

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
  cancelRequest:  defineRoute({ method: "POST", path: "/requests/:id/cancel",       access: ["counter", "prod"],            params: DocIdParamsSchema,       response: writeResponse(StockRequestSchema) }),
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
  // The store cancels the store's tickets and the kitchen the kitchen's; `requireLocOf` on the
  // ticket's `from` is what draws that line, which also puts a shop transfer's own ticket out
  // of reach of both (its `from` is an outlet). Phase 6 gives the counter that door.
  cancelTicket:   defineRoute({ method: "POST", path: "/tickets/:id/cancel",     access: ["store", "prod"],  params: DocIdParamsSchema, body: CancelTicketBodySchema,   response: writeResponse(TicketSchema) }),
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
  createItem:           defineRoute({ method: "POST",   path: "/items",                         access: ["store", "prod", "buyer"], body: CreateItemBodySchema,   response: writeResponse(NewItemResultSchema) }),
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
} as const;
export type RouteName = keyof typeof routes;
export const API_PREFIX = "/api/v1";
