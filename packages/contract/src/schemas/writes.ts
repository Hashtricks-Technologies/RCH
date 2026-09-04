import { z } from "zod";
import { LocKeySchema, PriceListSchema, TenderSchema } from "./common.js";
import { PayerSchema, ProdOrderSchema, ShopAskSchema, StockRequestSchema, TicketSchema } from "./documents.js";

/** Every domain slice a write can touch, so a client can invalidate/refetch precisely instead
 *  of reloading the whole snapshot after each mutation. Extracted so `events.ts` can name one
 *  collection at a time from the same enum. */
export const CollectionSchema = z.enum(["stock", "rsv", "ovr", "prices", "menu", "bills", "req", "tkt", "prq", "po", "pord", "batch", "grn", "vendors", "contracts", "tickets", "productReqs", "shopAsks"]);
export const ChangedSchema = z.array(CollectionSchema);
export type Changed = z.infer<typeof CollectionSchema>;

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

// Three decimals is the whole precision of a quantity anywhere in this system (`round3`), so
// `PayBodySchema` already refuses more; match it. Positivity is deliberately NOT here — a zero
// must reach the operator as the store's own "Enter a quantity", not a generic 400.
export const QtySchema = z.number().finite().multipleOf(0.001).max(100000);
export const ReqLineInputSchema = z.strictObject({ it: z.string().min(1).max(64), qty: QtySchema });
export const CreateRequestBodySchema = z.strictObject({ lines: z.array(ReqLineInputSchema).min(1).max(50), note: z.string().max(500).default(""), urgent: z.boolean().default(false) });
export const DocIdParamsSchema = z.strictObject({ id: z.string().min(1).max(40) });
export const ApproveRequestBodySchema = z.strictObject({ appr: z.array(QtySchema).min(1).max(50), note: z.string().max(500).default("") });
export const RejectRequestBodySchema = z.strictObject({ note: z.string().max(500) });
export const HandoverBodySchema = z.strictObject({ otp: z.string().regex(/^\d{6}$/).optional() });
export const TransferBodySchema = z.strictObject({ from: LocKeySchema, to: LocKeySchema, it: z.string().min(1).max(64), qty: QtySchema });
export const ShopAskBodySchema = z.strictObject({ to: LocKeySchema, it: z.string().min(1).max(64), qty: QtySchema, note: z.string().max(500).default("") });
export const AnswerShopAskBodySchema = z.strictObject({ grant: QtySchema });
export const DeclineShopAskBodySchema = z.strictObject({ reason: z.string().max(500) });

// `result` is the document the caller acted on. Two endpoints answer with a pair, because the
// operator needs the sibling in the same breath: an approval's `trimmed` is a property of the
// decision, not of the request row, and an issued ticket's OTP has to reach the store window.
export const ApprovalResultSchema = z.strictObject({ request: StockRequestSchema, trimmed: z.boolean() });
export const IssueResultSchema = z.strictObject({ request: StockRequestSchema, ticket: TicketSchema });
export const ShopAskSentResultSchema = z.strictObject({ ask: ShopAskSchema, ticket: TicketSchema });

// The kitchen's two ticket paths (Task 12). A distribution names one item and one destination;
// the kitchen decides the quantity, so there is no request behind it to read the lines from.
export const DistributeBodySchema = z.strictObject({ it: z.string().min(1).max(64), qty: QtySchema, to: LocKeySchema });
/** Dispatch changes the order and mints the ticket that carries it, and the kitchen needs both
 *  in one breath: the order moves to Dispatched and the collector is read the OTP. */
export const DispatchResultSchema = z.strictObject({ order: ProdOrderSchema, ticket: TicketSchema });
