import { z } from "zod";
import type { Role } from "./types.js";
import { OkResponseSchema } from "./schemas/common.js";
import { AuthResponseSchema, ChangePasswordBodySchema, LoginBodySchema, MeResponseSchema, PatchMeBodySchema } from "./schemas/auth.js";
import { BILL_DAYS, BillsResponseSchema, ItemsResponseSchema, LocationsResponseSchema, MenusResponseSchema, PricesResponseSchema, RecipesResponseSchema, RequestsResponseSchema, ShopAsksResponseSchema, SnapshotSchema, StockResponseSchema, TicketsResponseSchema } from "./schemas/snapshot.js";
import { BillSchema, ShopAskSchema, StockRequestSchema, TicketSchema } from "./schemas/documents.js";
import { AnswerShopAskBodySchema, ApproveRequestBodySchema, ApprovalResultSchema, CreateRequestBodySchema, DeclineShopAskBodySchema, DispatchResultSchema, DistributeBodySchema, DocIdParamsSchema, HandoverBodySchema, IssueResultSchema, MenuItemBodySchema, MenuItemParamsSchema, MenuLocParamsSchema, MenuResultSchema, PayBodySchema, PriceResultSchema, RejectRequestBodySchema, SavePriceBodySchema, SavePriceParamsSchema, ShopAskBodySchema, ShopAskSentResultSchema, ToggleAvailBodySchema, ToggleResultSchema, TransferBodySchema, writeResponse } from "./schemas/writes.js";

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
  // The three movement collections, each on its own, so a write that names "req", "tkt" or
  // "shopAsks" in `changed` refetches that slice and not the whole snapshot. `ticketsList`
  // rather than `tickets`, because `tickets` is the support-ticket collection and will be the
  // Phase 6 route name — two manifest keys must not collide.
  requests:    defineRoute({ method: "GET", path: "/requests",   access: "any", response: RequestsResponseSchema }),
  ticketsList: defineRoute({ method: "GET", path: "/tickets",    access: "any", response: TicketsResponseSchema }),
  shopAsks:    defineRoute({ method: "GET", path: "/shop-asks",  access: "any", response: ShopAsksResponseSchema }),
} as const;
export type RouteName = keyof typeof routes;
export const API_PREFIX = "/api/v1";
