import { z } from "zod";
import { IsoDate, ItemTypeSchema, LocKeySchema, PriceListIdSchema, SourceSchema, StockLocSchema, TenderSchema } from "./common.js";
import { AdjustmentRequestSchema, AdjustmentSchema, AdjustReasonSchema, GrnSchema, ItemSchema, PayerSchema, PordStatusSchema, ProdOrderSchema, PurchaseOrderSchema, ShopAskSchema, StockRequestSchema, TicketPrioritySchema, TicketSchema, TicketStatusSchema, TicketTopicSchema } from "./documents.js";

/** Every domain slice a write can touch, so a client can invalidate/refetch precisely instead
 *  of reloading the whole snapshot after each mutation. Extracted so `events.ts` can name one
 *  collection at a time from the same enum. `"items"` is here because `POST /items` changes the
 *  item master, which every screen reads out of one registry - without it the only honest
 *  `changed` a new product could name would be the whole snapshot. `"locations"` and `"outlets"`
 *  are the location master as the operational screens and the admin page each read it, and
 *  `"roster"` and `"payers"` are the payer register the same way round - the till's live list
 *  against the super admin's whole one. `"terms"` is the rate card. `"audit"`
 *  is never in a write's `changed`: it is the audit service's own notice that new events were
 *  stored, and the API's change stream sends it to admin streams only. `"receivables"` is the
 *  manager's Credit screen - who owes what and every payment behind it, derived at read time
 *  rather than stored, which is why it is one collection over two narrow reads. */
export const CollectionSchema = z.enum(["stock", "rsv", "ovr", "prices", "priceLists", "menu", "bills", "req", "tkt", "prq", "po", "pord", "batch", "grn", "vendors", "contracts", "tickets", "productReqs", "shopAsks", "items", "locations", "outlets", "roster", "payers", "terms", "receivables", "adjustments", "adjReq", "accounts", "audit"]);
export const ChangedSchema = z.array(CollectionSchema);
export type Changed = z.infer<typeof CollectionSchema>;

/** Every write route answers with { result, changed, message } - the mutated record, the
 *  slices to invalidate, and a human-readable summary for a toast. */
export const writeResponse = <T extends z.ZodTypeAny>(result: T) => z.strictObject({ result, changed: ChangedSchema, message: z.string() });
export type WriteResponse<T> = { result: T; changed: Changed[]; message: string };

export const PayBodySchema = z.strictObject({
  loc: LocKeySchema,
  tender: TenderSchema,
  payer: PayerSchema.optional(),
  // Three decimals is the whole precision of a quantity anywhere in this system (`round3`), so
  // a line that carries more is a client bug, not a sale - refuse it at the door rather than
  // rounding it silently into the ledger.
  lines: z.array(z.strictObject({ it: z.string().min(1).max(64), qty: z.number().positive().multipleOf(0.001).max(10000) })).min(1).max(100),
});
export const ToggleAvailBodySchema = z.strictObject({ loc: LocKeySchema, it: z.string().min(1).max(64) });
export const SavePriceParamsSchema = z.strictObject({ list: PriceListIdSchema, it: z.string().min(1).max(64) });
/** A price of nothing is not a price - the manager's screen already says "Enter a price greater than zero". */
export const SavePriceBodySchema = z.strictObject({ price: z.number().positive().max(100000) });
export const MenuLocParamsSchema = z.strictObject({ loc: LocKeySchema });
export const MenuItemParamsSchema = z.strictObject({ loc: LocKeySchema, it: z.string().min(1).max(64) });
export const MenuItemBodySchema = z.strictObject({ it: z.string().min(1).max(64) });
export const ToggleResultSchema = z.strictObject({ loc: LocKeySchema, it: z.string(), off: z.boolean(), reason: z.string().optional() });
export const PriceResultSchema = z.strictObject({ list: PriceListIdSchema, it: z.string(), price: z.number() });
export const MenuResultSchema = z.strictObject({ loc: LocKeySchema, items: z.array(z.string()) });

// ---- price lists ----
/** A new list is always cloned from one outlet's current active list, so the manager edits from
 *  a known baseline rather than an empty table. It is created inactive - creating one never
 *  switches any outlet onto it (`activatePriceList` is the separate, explicit step). */
export const CreatePriceListBodySchema = z.strictObject({ name: z.string().min(1).max(80), cloneFrom: LocKeySchema });
export const PriceListIdParamsSchema = z.strictObject({ id: PriceListIdSchema });
export const OutletParamsSchema = z.strictObject({ loc: LocKeySchema });
export const SetOutletPriceListBodySchema = z.strictObject({ listId: PriceListIdSchema });
export const DeletedPriceListSchema = z.strictObject({ id: PriceListIdSchema });
export const ActivatePriceListResultSchema = z.strictObject({ loc: LocKeySchema, listId: PriceListIdSchema });

// Three decimals is the whole precision of a quantity anywhere in this system (`round3`), so
// `PayBodySchema` already refuses more; match it. Positivity is deliberately NOT here - a zero
// must reach the operator as the store's own "Enter a quantity", not a generic 400.
export const QtySchema = z.number().finite().multipleOf(0.001).max(100000);
export const ReqLineInputSchema = z.strictObject({ it: z.string().min(1).max(64), qty: QtySchema });
export const CreateRequestBodySchema = z.strictObject({ lines: z.array(ReqLineInputSchema).min(1).max(50), note: z.string().max(500).default(""), urgent: z.boolean().default(false) });
export const DocIdParamsSchema = z.strictObject({ id: z.string().min(1).max(40) });
export const ApproveRequestBodySchema = z.strictObject({ appr: z.array(QtySchema).min(1).max(50), note: z.string().max(500).default("") });
export const RejectRequestBodySchema = z.strictObject({ note: z.string().max(500) });
/** The manager's alternative to the ordinary approve/reject: fulfil the whole request from a
 *  peer outlet's own shelf instead of the central store, when they know one is holding it. */
export const RedirectRequestBodySchema = z.strictObject({ from: LocKeySchema });
/** Six digits, and nothing else. The OTP used to be optional, and omitting it *was* the
 *  supervisor override - an OTP-less handover the store and the kitchen could take. That door is
 *  closed, so the field is required and the schema is what closes it: a body without an OTP is
 *  now a 400 before any handler runs. */
export const HandoverBodySchema = z.strictObject({ otp: z.string().regex(/^\d{6}$/) });
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

// The board's own two words: a status the kitchen presses, and a batch it logs. `Dispatched` is
// a member of PordStatusSchema and is accepted by the schema on purpose - it is refused in the
// service with a sentence that says where to go instead, because a stale tab pressing it needs
// an answer it can read, not a 400 - a dispatch has its own endpoint.
export const SetOrderStatusBodySchema = z.strictObject({ st: PordStatusSchema });
// `started` is what went into the oven and `made` is what came out of it; only the second reaches
// the rack (UA-14). A blank yield box means every unit came good, so `made` is optional rather
// than defaulted - a default of 0 would read a blank box as a lost tray.
export const MakeBatchBodySchema = z.strictObject({
  it: z.string().min(1).max(64),
  started: QtySchema,
  made: QtySchema.optional(),
  note: z.string().max(500).optional(),
});
/** A cancellation has to say why: the reason is the only record of it, since a ticket's row
 *  carries no prose and it ends up in document_history rather than on the ticket. */
export const CancelTicketBodySchema = z.strictObject({ reason: z.string().max(500) });

/** A rate, an MRP or a price on the wire. Non-negative - a free-of-charge line is legal, a
 *  negative one is a client bug - and bounded, for the same reason `QtySchema` is. */
export const RateSchema = z.number().finite().min(0).max(1_000_000).multipleOf(0.01);

// ---- requisitions (sendRequisition, approveRequisition, declineRequisition)
export const CreateRequisitionBodySchema = z.strictObject({
  lines: z.array(ReqLineInputSchema).min(1).max(50),
  note: z.string().max(500).default(""),
});
export const ApproveRequisitionBodySchema = z.strictObject({ appr: z.array(QtySchema).min(1).max(50), note: z.string().max(500).default("") });
export const DeclineRequisitionBodySchema = z.strictObject({ note: z.string().max(500) });
/** The buyer putting items on the procurement list without a store keeper's ask. No default on
 *  `note`: it is the reason, the service refuses a blank one with its own sentence, and a body
 *  that left the key out is a client that forgot to ask for it. */
export const AddToProcurementListBodySchema = z.strictObject({
  lines: z.array(ReqLineInputSchema).min(1).max(50),
  note: z.string().max(500),
});

// ---- purchase orders
/** One pick off the procurement list: a requisition, one of its lines by index, a quantity.
 *  Two picks of the same line are legal on the wire and summed by the service before the
 *  pending check - checking them one at a time would let their total overrun the line. */
export const PickSchema = z.strictObject({ prq: z.string().min(1).max(40), line: z.number().int().min(0).max(49), qty: QtySchema });
export const CreatePoBodySchema = z.strictObject({ vendorId: z.string().min(1).max(40), picks: z.array(PickSchema).max(100) });
export const PoLineParamsSchema = z.strictObject({ id: z.string().min(1).max(40), n: z.coerce.number().int().min(0).max(99) });
export const UpdatePoLineBodySchema = z.strictObject({ qty: QtySchema.optional(), rate: RateSchema.optional() });
/** The vendor may move only while the order is a draft; the expected date may move at any open
 *  status. One PATCH, because the drawer offers both in the same panel. */
export const PatchPoBodySchema = z.strictObject({ vendorId: z.string().min(1).max(40).optional(), eta: IsoDate.optional() });
export const CancelPoBodySchema = z.strictObject({ reason: z.string().max(500) });
/** One instalment against one order. `lines` is positional against the order's own lines - the
 *  same shape `approve` takes for a request - and a length that does not match is refused with a
 *  sentence rather than read as "nothing arrived on the lines you left out". */
export const ReceiptLineInputSchema = z.strictObject({
  recv: QtySchema, rejected: QtySchema.default(0), batch: z.string().max(60).default(""),
  mrp: RateSchema.default(0),
  // A wire date or nothing at all - the shape `invDate` already uses. `GrnSchema.mfg`/`exp` are
  // `IsoDate` and the columns behind them are `date NOT NULL`, so a loose `z.string()` would let
  // "08-09-2026" through two string comparisons that happen not to catch it and reach Postgres
  // as a 500. Empty is the not-supplied case, which the service refuses with the store's own
  // "needs a manufacturing and an expiry date".
  mfg: z.union([IsoDate, z.literal("")]).default(""),
  exp: z.union([IsoDate, z.literal("")]).default(""),
});
export const ReceivePoBodySchema = z.strictObject({
  dc: z.string().max(60), invoice: z.string().max(60).default(""), invDate: z.union([IsoDate, z.literal("")]).default(""),
  lines: z.array(ReceiptLineInputSchema).min(1).max(100),
});
export const CloseShortBodySchema = z.strictObject({ reason: z.string().max(500) });

// ---- vendors
export const VendorBodySchema = z.strictObject({
  n: z.string().max(120), gstin: z.string().max(20).default(""), contact: z.string().max(120).default(""),
  ph: z.string().max(40).default(""), terms: z.string().max(60).default(""),
  lead: z.number().int().min(0).max(365).default(0), groups: z.array(z.string().max(40)).max(20).default([]),
});
/** Declared field by field rather than as `VendorBodySchema.partial()`: Zod carries a
 *  `.default()` through `.partial()`, so the partial of a defaulted schema parses `{}` into
 *  `{ lead: 0, groups: [] }` - which would make "Nothing to change" unreachable and would reset
 *  a vendor's lead time and groups on every patch of any other field. Optional, never defaulted. */
export const PatchVendorBodySchema = z.strictObject({
  n: z.string().max(120).optional(), gstin: z.string().max(20).optional(),
  contact: z.string().max(120).optional(), ph: z.string().max(40).optional(),
  terms: z.string().max(60).optional(), lead: z.number().int().min(0).max(365).optional(),
  groups: z.array(z.string().max(40)).max(20).optional(), active: z.boolean().optional(),
});

// ---- rate contracts
export const ContractBodySchema = z.strictObject({
  vendorId: z.string().min(1).max(40), it: z.string().min(1).max(64), rate: RateSchema,
  from: IsoDate, to: IsoDate, moq: QtySchema.default(0),
});
export const PatchContractBodySchema = z.strictObject({
  rate: RateSchema.optional(), from: IsoDate.optional(), to: IsoDate.optional(),
  moq: QtySchema.optional(), active: z.boolean().optional(),
});

// ---- the item master
/** What the three new-product drawers send. `key`, `code`, `grp`, `hsn` and `gst` are optional
 *  because the buyer's drawer leaves all five blank and the server applies the same defaults the
 *  store has always applied (unit nos, hsn 2106, gst 5). */
export const CreateItemBodySchema = z.strictObject({
  key: z.string().max(64).default(""), name: z.string().max(120), code: z.string().max(40).default(""),
  unit: z.string().max(12).default("nos"), type: ItemTypeSchema, grp: z.string().max(40).default(""),
  hsn: z.string().max(12).default(""), gst: z.number().min(0).max(100).default(5),
  reorder: QtySchema.default(0), cost: RateSchema, mrp: RateSchema.optional(), sl: z.number().int().min(0).max(100000).optional(),
  loc: LocKeySchema, opening: QtySchema.default(0), src: SourceSchema.optional(),
});

// ---- new-product requests
export const CreateProductRequestBodySchema = z.strictObject({ name: z.string().max(120), why: z.string().max(1000).default(""), forLoc: LocKeySchema });
export const AnswerProductRequestBodySchema = z.strictObject({
  st: z.enum(["Created", "Declined"]), note: z.string().max(500).default(""), itemKey: z.string().max(64).optional(),
});

// `result` is the document acted on, except two. A receipt answers with the GRNs it wrote
// beside the order, because the store keeper wants to read the batch numbers back in the same
// breath (the precedent is `issue-ticket` handing over the OTP); and a new item answers with
// the key the server chose, which is the one thing the caller cannot work out for itself. A
// claim-moving write answers with the order alone and names "prq" in `changed` - the buyer's
// procurement list repaints from that refetch, so returning the requisitions too would be a
// second channel for a fact one read already carries.
export const ReceiptResultSchema = z.strictObject({ po: PurchaseOrderSchema, grns: z.array(GrnSchema) });
/** One line of the item master, with the key the server chose. `createItem` and `patchItem`
 *  answer with the same shape: a create needs the key because the caller cannot work it out,
 *  and a patch answers with it too rather than inventing a second envelope for the same row. */
export const ItemResultSchema = z.strictObject({ key: z.string(), item: ItemSchema });

// ---- item patch ----
/** The item master is editable (`PATCH /items/:it`). Which of these nine fields a role may
 *  actually move is `ITEM_FIELD_ROLES` in `@rch/domain` - a sentence, not a 400 - so the schema
 *  takes all nine from anyone and the service refuses in the operator's own words. No
 *  `.default()` anywhere: `parse({})` must stay empty, or "Nothing to change" is unreachable
 *  and a patch of one field silently resets the other eight. */
export const ItemKeyParamsSchema = z.strictObject({ it: z.string().min(1).max(64) });
export const PatchItemBodySchema = z.strictObject({
  n: z.string().max(120).optional(),
  mrp: RateSchema.optional(),
  cost: RateSchema.optional(),
  gst: z.number().min(0).max(100).optional(),
  hsn: z.string().max(12).optional(),
  rl: QtySchema.optional(),
  grp: z.string().max(40).optional(),
  sl: z.number().int().min(0).max(100000).optional(),
  active: z.boolean().optional(),
  src: SourceSchema.optional(),
});

// ---- item photos ----
/** One photo, base64. The ceiling here is only the transport's (the API's body limit is 1 MiB);
 *  the 700 KB rule and the type check are `checkPhoto` in `@rch/domain`, refused as a sentence. */
export const SetItemImageBodySchema = z.strictObject({
  data: z.string().min(1).max(1_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

// ---- The support desk. Customer care for the portal itself: every role raises,
// replies to, resolves and rates its own tickets, and nothing here moves stock.
export const RaiseTicketBodySchema = z.strictObject({
  topic: TicketTopicSchema,
  // Non-empty is a service rule, so an empty subject reaches the operator as the store's own
  // sentence rather than a 400 with a Zod path in it. The cap is what a subject line can be.
  subject: z.string().max(200),
  body: z.string().max(4000),
  priority: TicketPrioritySchema,
  screen: z.string().max(60),
});
export const ReplyToTicketBodySchema = z.strictObject({ body: z.string().max(4000) });
/** The schema takes any of the five words; which of them a *user* may choose is the service's
 *  rule (a user may set Resolved/Closed only), because that is a sentence, not a 400. */
export const SetTicketStatusBodySchema = z.strictObject({ st: TicketStatusSchema });
export const RateTicketBodySchema = z.strictObject({ rating: z.number().int().min(1).max(5) });
/** The admin answering as the desk. `st` is what the reply box's two other buttons send
 *  (Send & ask user, Send & resolve); a plain Send leaves it out. Whether the ticket may move
 *  there from where it stands is the service's sentence, not a 400. The desk's status moves
 *  reuse `SetTicketStatusBodySchema`, and `mayDeskSet` decides which of the five it may send. */
export const DeskReplyBodySchema = z.strictObject({
  body: z.string().max(4000),
  st: z.enum(["Waiting on you", "Resolved"]).optional(),
});

// ---- bill void. A mis-keyed bill, taken back on the day it was taken and no later.
/** A bill number carries a slash (`CF/1188`), so this one param reaches the server
 *  percent-encoded - `UI/src/api/client.ts` encodes every path param and nginx forwards the
 *  encoded form unchanged. The cap is a document id's, like `DocIdParamsSchema`. */
export const BillNoParamsSchema = z.strictObject({ no: z.string().min(1).max(40) });
/** Non-empty is a service rule, not a schema one: an empty box must reach the manager as the
 *  desk's own "Give a reason for voiding this bill", not a 400 with a Zod path in it. */
export const VoidBillBodySchema = z.strictObject({ reason: z.string().max(500) });
// ---- adjustments (write-off / count-up as a document)
/** A signed quantity. Negative writes stock off - wastage, breakage, an expiry disposal, a
 *  consignment sent back to the vendor - and positive counts it up, which is what a physical
 *  count that found more than the books say comes to. Zero is deliberately left to the service:
 *  a repeated item is folded first and a line that folds to nothing is dropped, so an
 *  adjustment with nothing on it reads as the store's own sentence rather than as a 400 with a
 *  Zod path in it. Three decimals and the same ceiling `QtySchema` carries, in both directions. */
export const SignedQtySchema = z.number().finite().multipleOf(0.001).min(-100000).max(100000);
/** `loc` is `StockLocSchema` and not `LocKeySchema` - the one exception to the rule that a write
 *  body names one of the five places an operator works. Every other body names two ends of a
 *  movement, and quarantine is neither end of anything. An adjustment is not a movement: it is a
 *  correction to one shelf, and quarantine is a shelf. What a goods receipt turned away has to
 *  be disposable or sent back, or the rejected-goods pile only ever grows. */
export const CreateAdjustmentBodySchema = z.strictObject({
  loc: StockLocSchema,
  reason: AdjustReasonSchema,
  note: z.string().max(500).default(""),
  lines: z.array(z.strictObject({ it: z.string().min(1).max(64), qty: SignedQtySchema })).min(1).max(100),
});
// ---- prod-order raise ----
/** An outlet (or the manager, on its behalf) asking the Central Kitchen to make something.
 *  `from` is the outlet the tray is for: a counter never sends it - the route pins it to the
 *  token - and the manager must, because one manager supervises every outlet and the server
 *  cannot guess which one is short. Positivity is a service rule, not a schema rule, the way
 *  `ReqLineInputSchema` has always had it: a zero reaches the operator as "Enter a quantity on
 *  every line", not as a 400 with a Zod path in it. */
export const CreateProdOrderBodySchema = z.strictObject({
  from: LocKeySchema.optional(),
  lines: z.array(ReqLineInputSchema).min(1).max(50),
  need: IsoDate.optional(),
  note: z.string().max(500).default(""),
});

// ---- adjustment requests (the counter raises, the outlet manager decides)
/** What the counter sends to raise one - the same signed-line shape `CreateAdjustmentBodySchema`
 *  takes, with no location: the route pins it to the token, exactly as `CreateRequestBodySchema` does. */
export const CreateAdjustmentRequestBodySchema = z.strictObject({
  reason: AdjustReasonSchema,
  note: z.string().max(500).default(""),
  lines: z.array(z.strictObject({ it: z.string().min(1).max(64), qty: SignedQtySchema })).min(1).max(100),
});
/** Non-empty is a service rule, not a schema one - the same shape `RejectRequestBodySchema` takes. */
export const RejectAdjustmentRequestBodySchema = z.strictObject({ note: z.string().max(500) });
/** Approving one both decides the request and writes the correction in the same breath, so the
 *  manager reads the `ADJ-` number it became without a second round trip. */
export const ApproveAdjustmentRequestResultSchema = z.strictObject({ request: AdjustmentRequestSchema, adjustment: AdjustmentSchema });
