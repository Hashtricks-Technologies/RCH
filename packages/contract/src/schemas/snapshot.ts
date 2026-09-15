import { z } from "zod";
import { LocKeySchema, Money, PriceListIdSchema, Qty, StockLocSchema } from "./common.js";
import * as D from "./documents.js";

// Not every caller sees every location - a counter operator's snapshot is scoped down to their
// own (`scope()`) - and the set of locations is data, so these are records keyed by a checked key
// rather than exhaustive records over a list.
const byLoc = <T extends z.ZodTypeAny>(v: T) => z.record(LocKeySchema, v);
/** Stock is reported for quarantine too - the store keeper has to see what was rejected - while
 *  `menu` and every write body stay on locations an operator may act on. */
const byStockLoc = <T extends z.ZodTypeAny>(v: T) => z.record(StockLocSchema, v);
export const SnapshotSchema = z.object({
  user: D.UserSchema,
  items: z.record(z.string(), D.ItemSchema),
  locations: z.record(z.string(), D.LocationSchema),
  users: z.array(D.UserMinSchema),   // the directory, not a contact list - `user` above is the caller's own, whole
  roster: D.PayerRosterSchema,       // the other directory of people: who a bill may be charged to
  stock: byStockLoc(z.record(z.string(), Qty)),
  rsv: z.record(z.string(), Qty),          // "loc:item" -> reserved
  ovr: z.record(z.string(), z.string()),   // "loc:item" -> reason
  prices: z.record(PriceListIdSchema, z.record(z.string(), z.number())),
  // The price lists themselves - name and which outlets are on each - alongside `prices`'
  // flat item->price maps, for the manager's price-list management screen.
  priceLists: z.array(D.PriceListSchema),
  menu: byLoc(z.array(z.string())),
  req: z.array(D.StockRequestSchema),
  tkt: z.array(D.TicketSchema),
  prq: z.array(D.RequisitionSchema),
  po: z.array(D.PurchaseOrderSchema),
  pord: z.array(D.ProdOrderSchema),
  batch: z.array(D.BatchSchema),
  bills: z.array(D.BillSchema),
  grn: z.array(D.GrnSchema),
  vendors: z.array(D.VendorSchema),
  contracts: z.array(D.RateContractSchema),
  tickets: z.array(D.SupportTicketSchema),
  productReqs: z.array(D.ProductRequestSchema),
  shopAsks: z.array(D.ShopAskSchema),
  // One record per day, oldest first and matching `dayLabels`, keyed by outlet - closed outlets
  // included, since what a closed outlet took last week is still takings.
  sales: z.array(z.record(LocKeySchema, Money)),
  dayLabels: z.array(z.string()),
  // ---- adjustments: the write-offs and count-ups behind the `adjustment` moves on the ledger.
  adjustments: z.array(D.AdjustmentSchema),
  // ---- adjustment requests: a counter's asks, decided or still waiting on the outlet manager.
  adjReq: z.array(D.AdjustmentRequestSchema),
});
export const ItemsResponseSchema = z.record(z.string(), D.ItemSchema);
export const LocationsResponseSchema = z.record(z.string(), D.LocationSchema);
export const PricesResponseSchema = SnapshotSchema.shape.prices;
export const PriceListsResponseSchema = SnapshotSchema.shape.priceLists;
export const MenusResponseSchema = SnapshotSchema.shape.menu;
export const StockResponseSchema = z.strictObject({ stock: SnapshotSchema.shape.stock, rsv: SnapshotSchema.shape.rsv, ovr: SnapshotSchema.shape.ovr });
/** How many days of bills a caller gets - the snapshot's window and `GET /bills`'s default,
 *  one number so that `applyBills` replacing the store's list wholesale stays correct. */
export const BILL_DAYS = 7;
export const BillsResponseSchema = z.array(D.BillSchema);
/** The three movement collections on their own, so a write can refetch just the slice it
 *  named in `changed` instead of pulling the whole snapshot back down. */
export const RequestsResponseSchema = z.array(D.StockRequestSchema);
export const TicketsResponseSchema = z.array(D.TicketSchema);
export const ShopAsksResponseSchema = z.array(D.ShopAskSchema);
export const ProdOrdersResponseSchema = z.array(D.ProdOrderSchema);
export const BatchesResponseSchema = z.array(D.BatchSchema);
/** The six buying collections on their own, so a write that names "prq", "po", "grn",
 *  "vendors", "contracts" or "productReqs" refetches its own slice. */
export const RequisitionsResponseSchema = z.array(D.RequisitionSchema);
export const PurchaseOrdersResponseSchema = z.array(D.PurchaseOrderSchema);
export const GrnsResponseSchema = z.array(D.GrnSchema);
export const VendorsResponseSchema = z.array(D.VendorSchema);
export const ContractsResponseSchema = z.array(D.RateContractSchema);
export const ProductRequestsResponseSchema = z.array(D.ProductRequestSchema);
/** A list of support tickets. `GET /support/tickets` answers with the caller's own: every role
 *  sees only what it raised, because none of the five answers tickets. `GET /admin/support/tickets`
 *  answers the admin, who does answer them, with everybody's, in the same shape. */
export const SupportTicketsResponseSchema = z.array(D.SupportTicketSchema);

// ---- payers ----
/** The roster on its own, so a notice naming "roster" refetches that register alone instead of
 *  the whole snapshot. Scoped exactly as the snapshot's own copy is: the kitchen,
 *  the store and the buyer never open a payer picker and read an empty one (`scopeRoster`). */
export const RosterResponseSchema = D.PayerRosterSchema;
// ---- adjustments
/** The adjustment register on its own, so a write naming "adjustments" refetches that slice
 *  rather than the whole snapshot. Scoped like `stock`: a counter sees its own. */
export const AdjustmentsResponseSchema = z.array(D.AdjustmentSchema);
// ---- adjustment requests
/** The request queue on its own, so a write naming "adjReq" refetches that slice rather than
 *  the whole snapshot. Scoped like `req`: a counter sees its own outlet's. */
export const AdjustmentRequestsResponseSchema = z.array(D.AdjustmentRequestSchema);
