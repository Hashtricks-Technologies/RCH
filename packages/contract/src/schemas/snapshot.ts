import { z } from "zod";
import { LocKeySchema, Qty, StockLocSchema } from "./common.js";
import * as D from "./documents.js";

// Not every caller sees every location - a counter operator's snapshot is scoped down to their
// own (`scope()`), so this can't require all keys the way an exhaustive z.record(enum, ...) would.
const byLoc = <T extends z.ZodTypeAny>(v: T) => z.partialRecord(LocKeySchema, v);
/** Stock is reported for quarantine too — the store keeper has to see what was rejected — while
 *  `menu` and every write body stay on the five an operator may act on. */
const byStockLoc = <T extends z.ZodTypeAny>(v: T) => z.partialRecord(StockLocSchema, v);
export const SnapshotSchema = z.object({
  user: D.UserSchema,
  items: z.record(z.string(), D.ItemSchema),
  locations: z.record(z.string(), D.LocationSchema),
  recipes: z.record(z.string(), D.RecipeSchema),
  users: z.array(D.UserMinSchema),   // the directory, not a contact list — `user` above is the caller's own, whole
  stock: byStockLoc(z.record(z.string(), Qty)),
  rsv: z.record(z.string(), Qty),          // "loc:item" -> reserved
  ovr: z.record(z.string(), z.string()),   // "loc:item" -> reason
  prices: z.object({ A: z.record(z.string(), z.number()), B: z.record(z.string(), z.number()) }),
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
  sales: z.array(z.array(z.number())),
  dayLabels: z.array(z.string()),
});
export const ItemsResponseSchema = z.record(z.string(), D.ItemSchema);
export const LocationsResponseSchema = z.record(z.string(), D.LocationSchema);
export const RecipesResponseSchema = z.record(z.string(), D.RecipeSchema);
export const PricesResponseSchema = SnapshotSchema.shape.prices;
export const MenusResponseSchema = SnapshotSchema.shape.menu;
export const StockResponseSchema = z.strictObject({ stock: SnapshotSchema.shape.stock, rsv: SnapshotSchema.shape.rsv, ovr: SnapshotSchema.shape.ovr });
/** How many days of bills a caller gets — the snapshot's window and `GET /bills`'s default,
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
 *  "vendors", "contracts" or "productReqs" refetches its own slice (spec §9.1). */
export const RequisitionsResponseSchema = z.array(D.RequisitionSchema);
export const PurchaseOrdersResponseSchema = z.array(D.PurchaseOrderSchema);
export const GrnsResponseSchema = z.array(D.GrnSchema);
export const VendorsResponseSchema = z.array(D.VendorSchema);
export const ContractsResponseSchema = z.array(D.RateContractSchema);
export const ProductRequestsResponseSchema = z.array(D.ProductRequestSchema);
