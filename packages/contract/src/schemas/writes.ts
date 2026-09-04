import { z } from "zod";
import { LocKeySchema, PriceListSchema, TenderSchema } from "./common.js";
import { PayerSchema } from "./documents.js";

/** Every domain slice a write can touch, so a client can invalidate/refetch precisely instead
 *  of reloading the whole snapshot after each mutation. */
export const ChangedSchema = z.array(z.enum(["stock", "rsv", "ovr", "prices", "menu", "bills", "req", "tkt", "prq", "po", "pord", "batch", "grn", "vendors", "contracts", "tickets", "productReqs", "shopAsks"]));
export type Changed = z.infer<typeof ChangedSchema>[number];

/** Every write route answers with { result, changed, message } — the mutated record, the
 *  slices to invalidate, and a human-readable summary for a toast. */
export const writeResponse = <T extends z.ZodTypeAny>(result: T) => z.strictObject({ result, changed: ChangedSchema, message: z.string() });
export type WriteResponse<T> = { result: T; changed: Changed[]; message: string };

export const PayBodySchema = z.strictObject({
  loc: LocKeySchema,
  tender: TenderSchema,
  payer: PayerSchema.optional(),
  // Three decimals is the whole precision of a quantity anywhere in this system (`round3`), so
  // a line that carries more is a client bug, not a sale — refuse it at the door rather than
  // rounding it silently into the ledger.
  lines: z.array(z.strictObject({ it: z.string().min(1).max(64), qty: z.number().positive().multipleOf(0.001).max(10000) })).min(1).max(100),
});
export const ToggleAvailBodySchema = z.strictObject({ loc: LocKeySchema, it: z.string().min(1).max(64) });
export const SavePriceParamsSchema = z.strictObject({ list: PriceListSchema, it: z.string().min(1).max(64) });
/** A price of nothing is not a price — the manager's screen already says "Enter a price greater than zero". */
export const SavePriceBodySchema = z.strictObject({ price: z.number().positive().max(100000) });
export const MenuLocParamsSchema = z.strictObject({ loc: LocKeySchema });
export const MenuItemParamsSchema = z.strictObject({ loc: LocKeySchema, it: z.string().min(1).max(64) });
export const MenuItemBodySchema = z.strictObject({ it: z.string().min(1).max(64) });
export const ToggleResultSchema = z.strictObject({ loc: LocKeySchema, it: z.string(), off: z.boolean(), reason: z.string().optional() });
export const PriceResultSchema = z.strictObject({ list: PriceListSchema, it: z.string(), price: z.number() });
export const MenuResultSchema = z.strictObject({ loc: LocKeySchema, items: z.array(z.string()) });
