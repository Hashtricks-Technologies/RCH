import { z } from "zod";
import { LocKeySchema, Qty } from "./common.js";
import * as D from "./documents.js";

// Not every caller sees every location - a counter operator's snapshot is scoped down to their
// own (Task 11's `scope()`), so this can't require all five keys the way an exhaustive
// z.record(enum, ...) would.
const byLoc = <T extends z.ZodTypeAny>(v: T) => z.partialRecord(LocKeySchema, v);
export const SnapshotSchema = z.object({
  user: D.UserSchema,
  items: z.record(z.string(), D.ItemSchema),
  locations: z.record(z.string(), D.LocationSchema),
  recipes: z.record(z.string(), D.RecipeSchema),
  users: z.array(D.UserMinSchema),   // the directory, not a contact list — `user` above is the caller's own, whole
  stock: byLoc(z.record(z.string(), Qty)),
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
export const BillsResponseSchema = z.array(D.BillSchema);
