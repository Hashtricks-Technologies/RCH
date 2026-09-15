import { z } from "zod";
import { IsoDate, IsoTime, ItemTypeSchema, LocKeySchema, Money, PriceListIdSchema, Qty, RoleSchema, SourceSchema, StockLocSchema, TenderSchema } from "./common.js";

export const ReqStatusSchema = z.enum(["Draft", "Request sent", "Manager approved", "Partially approved", "Ticket issued", "Collected", "Received", "Closed", "Rejected", "Cancelled"]);
// A ticket that was issued and never collected is withdrawn rather than left open: the hold it
// placed has to be released, and "Cancelled" is what the release is recorded as.
export const TktStatusSchema = z.enum(["Issued", "Collected", "Received", "Cancelled"]);
export const PrqStatusSchema = z.enum(["Sent", "Approved", "Partially approved", "Declined"]);
export const PordStatusSchema = z.enum(["New", "Accepted", "In kitchen", "Ready", "Dispatched", "Declined"]);
export const PoStatusSchema = z.enum(["Draft", "Ordered", "Partially received", "Received", "Cancelled"]);
export const ToneSchema = z.enum(["ok", "wn", "cr", "in", "ac", "mu"]);
export const PayerKindSchema = z.enum(["patient", "staff", "dept"]);
/** Customer care for the portal itself - not an operational problem in the kitchen. */
export const TicketTopicSchema = z.enum(["Sign in & access", "A screen will not load", "A number looks wrong", "Printing & receipts", "Slow or freezing", "Training & how do I", "Feature request", "Something else"]);
export const TicketPrioritySchema = z.enum(["Low", "Normal", "Urgent"]);
export const TicketStatusSchema = z.enum(["Open", "With support", "Waiting on you", "Resolved", "Closed"]);
/** A shop asking the central store to put a product on the master that is not there yet. */
export const ProductReqStatusSchema = z.enum(["Requested", "Created", "Declined"]);
export const ShopAskStatusSchema = z.enum(["Asked", "Sent", "Declined"]);

export const ItemSchema = z.object({
  c: z.string(), n: z.string(), u: z.string(), t: ItemTypeSchema, g: z.string(),
  hsn: z.string(), gst: z.number(), rl: Qty, cost: Money, mrp: Money.optional(), sl: z.number().optional(),
  // ---- item patch ----
  // A retired line stays on the wire: a bill, a ticket or a purchase order raised months ago
  // still names its item, and the screen showing that document needs the name. Optional, and
  // absent reads as **true** - the pickers filter on `active === false`, the registry does not,
  // and a fixture that predates retiring an item is still a valid item.
  active: z.boolean().optional(),
  // Absent reads through `sourceOf` (`@rch/domain`), which falls back to the item's type.
  src: SourceSchema.optional(),
  // ---- item photos ----
  // The sha256 of the photo's bytes, absent when the item has none. It is both the photo's
  // version and its address (`itemImagePath`), so a changed photo is a new URL and the old one
  // stops being served.
  img: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export const LocationSchema = z.object({
  n: z.string(), c: z.string(), type: z.enum(["Store", "Kitchen", "Outlet"]),
  floor: z.string(), cc: z.string(), list: PriceListIdSchema.optional(),
  // ---- outlets. Whether the location still trades, and how much of an item's reorder level one
  // par covers there (`parFactor` in @rch/domain). Required, unlike `Item.active`: every row in
  // `locations` carries both, so the server always sends both.
  active: z.boolean(),
  par: z.number().positive(),
});
/** A named price list, and the outlets currently active on it. `outlets` is derived at read
 *  time (every `Location` whose `list` names this id) - never stored on the list itself, so it
 *  can never drift from what `locations` actually says. */
export const PriceListSchema = z.strictObject({
  id: PriceListIdSchema, name: z.string().min(1).max(80), outlets: z.array(LocKeySchema),
});
export const UserSchema = z.object({
  id: z.string(), n: z.string(), e: z.string(), r: RoleSchema, rl: z.string(),
  loc: LocKeySchema, col: z.string(), emp: z.string(), ph: z.string(),
  // Whether this account can reach the account-management page - a capability, not a role
  // (root CLAUDE.md). `UserSchema` describes only the signed-in caller's own record (login,
  // refresh, change-password, snapshot.user); a colleague is always `UserMinSchema`, which does
  // not carry this, so nobody sees whether anyone but themselves has it.
  admin: z.boolean(),
});
/** What one colleague sees of another. Email, employee number and phone belong to the person
 *  they describe: the caller's own record travels whole, in `snapshot.user`, and nobody else's does. */
export const UserMinSchema = z.strictObject({
  id: z.string(), n: z.string(), r: RoleSchema, rl: z.string(), loc: LocKeySchema, col: z.string(),
});
export const ReqLineSchema = z.object({ it: z.string(), qty: Qty, appr: Qty, short: Qty.optional() });
export const HistEntrySchema = z.object({ s: z.string(), who: z.string(), t: IsoTime });
export const StockRequestSchema = z.object({
  id: z.string(), from: LocKeySchema, by: z.string(), at: IsoTime,
  lines: z.array(ReqLineSchema), st: ReqStatusSchema, ticket: z.string().nullable(),
  mgrNote: z.string(), urg: z.boolean().optional(), hist: z.array(HistEntrySchema), apprBy: z.string().optional(),
});
export const TktLineSchema = z.object({ it: z.string(), qty: Qty });
export const TicketSchema = z.object({
  id: z.string(), req: z.string(), from: LocKeySchema, to: LocKeySchema,
  lines: z.array(TktLineSchema), st: TktStatusSchema,
  /** Six digits quoted at handover in place of a scanned code. */
  otp: z.string(),
  /** Issued, handed over (including a supervisor override), received, withdrawn. Required, like
   *  every other document's trail: an optional history is one half the screens forget to render. */
  hist: z.array(HistEntrySchema),
});
export const PrqLineSchema = z.object({ it: z.string(), qty: Qty, appr: Qty, ordered: Qty, short: Qty.optional() });
export const RequisitionSchema = z.object({
  id: z.string(), by: z.string(), at: IsoTime, lines: z.array(PrqLineSchema), st: PrqStatusSchema, note: z.string(),
  apprBy: z.string().optional(), apprNote: z.string().optional(), hist: z.array(HistEntrySchema),
});
export const PoLineSrcSchema = z.object({ prq: z.string(), line: z.number().int(), qty: Qty });
export const PoLineSchema = z.object({ it: z.string(), qty: Qty, rate: Money, src: z.array(PoLineSrcSchema), recv: Qty, rejected: Qty });
export const PurchaseOrderSchema = z.object({
  id: z.string(), vendor: z.string(), at: IsoTime, lines: z.array(PoLineSchema), st: PoStatusSchema, eta: z.string(),
  needsApproval: z.boolean().optional(), shortNote: z.string().optional(), recv: IsoTime.optional(), hist: z.array(HistEntrySchema),
});
export const ProdOrderSchema = z.object({
  id: z.string(), from: LocKeySchema, by: z.string(), at: IsoTime, lines: z.array(TktLineSchema), st: PordStatusSchema, note: z.string(), hist: z.array(HistEntrySchema),
  // ---- prod-order raise ---- when the outlet said it needs the tray by. Optional because the
  // column is nullable and an order with no date is the ordinary case - the reader leaves the
  // key off entirely rather than sending a blank one, the same `strip()` treatment `shortNote`
  // gets, so "no date" is one shape on the wire rather than two.
  need: IsoDate.optional(),
});
export const BatchSchema = z.object({ id: z.string(), it: z.string(), qty: Qty, made: Qty, at: IsoTime, bb: IsoTime, note: z.string().optional() });
export const PayerSchema = z.strictObject({ kind: PayerKindSchema, id: z.string(), name: z.string() });
/** Who a bill may be charged to. Served from the `payers` table, not from a fixture: the till
 *  has validated its payer against that table since Phase 3 and the two lists must be one. */
export const PayerRosterSchema = z.strictObject({
  patients: z.array(PayerSchema), staff: z.array(PayerSchema), depts: z.array(PayerSchema),
});
/** What a store keeper recorded when the goods actually landed. */
export const ReceiptLineSchema = z.object({ recv: Qty, batch: z.string(), mrp: Money, mfg: z.string(), exp: z.string(), rejected: Qty });
/** The vendor's paperwork behind one instalment of a delivery. */
export const ReceiptDocSchema = z.object({ dc: z.string(), invoice: z.string(), invDate: z.string() });
export const GrnSchema = z.object({
  id: z.string(), po: z.string(), it: z.string(), qty: Qty, rejected: Qty, batch: z.string(), mrp: Money, mfg: IsoDate, exp: IsoDate,
  dc: z.string(), invoice: z.string(), invDate: z.string(), at: IsoTime, by: z.string(),
});
export const BillLineSchema = z.object({ it: z.string(), qty: Qty, rate: Money });
export const BillSchema = z.object({
  no: z.string(), loc: LocKeySchema, opr: z.string(), oprCol: z.string(), tot: Money, tax: Money, t: IsoTime, pay: TenderSchema,
  lines: z.array(BillLineSchema), payer: PayerSchema.optional(),
  // ---- bill void. Optional because a bill is voided almost never: the mapper omits both keys
  // on the overwhelming majority of bills, which keeps a wire bill equal to the fixture it came
  // from. A voided bill still carries its lines and its total - nothing is erased, the moves are
  // reversed - so every screen that already prints it goes on printing it, with a badge.
  voided: z.boolean().optional(), voidReason: z.string().optional(),
});
export const DraftLineSchema = z.object({ it: z.string(), qty: Qty });
export const AvailabilitySchema = z.object({ ok: z.boolean(), mode: z.enum(["Manual", "Stock"]), why: z.string().optional(), left: z.string().optional() });
export const PriceSchema = z.object({ p: Money, listed: Money, capped: z.boolean() });
export const DrawerStateSchema = z.object({ t: z.string(), id: z.string() });
export const VendorSchema = z.object({
  id: z.string(), n: z.string(), gstin: z.string(), contact: z.string(), ph: z.string(), terms: z.string(), lead: z.number(), groups: z.array(z.string()), active: z.boolean(),
});
export const TicketMessageSchema = z.object({ id: z.string(), from: z.enum(["user", "support"]), who: z.string(), at: IsoTime, body: z.string() });
export const SupportTicketSchema = z.object({
  id: z.string(), topic: TicketTopicSchema, subject: z.string(), priority: TicketPrioritySchema, st: TicketStatusSchema,
  by: z.string(), role: RoleSchema, loc: LocKeySchema, at: IsoTime, screen: z.string(), messages: z.array(TicketMessageSchema),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
});
export const ProductRequestSchema = z.object({
  id: z.string(), name: z.string(), why: z.string(), forLoc: LocKeySchema, by: z.string(), at: IsoTime, st: ProductReqStatusSchema,
  note: z.string().optional(), itemKey: z.string().optional(),
});
export const RateContractSchema = z.object({
  id: z.string(), vendor: z.string(), it: z.string(), rate: Money, from: z.string(), to: z.string(), moq: Qty, active: z.boolean(),
});
/** One shop asking another for stock it is holding. The manager sees it; it never routes through them. */
export const ShopAskSchema = z.object({
  id: z.string(), from: LocKeySchema, to: LocKeySchema, it: z.string(), qty: Qty, st: ShopAskStatusSchema, by: z.string(), at: IsoTime, note: z.string(),
  grant: Qty.optional(), ticket: z.string().optional(), reason: z.string().optional(),
});

// ---- adjustments (write-off / count-up as a document)
/** Why a shelf was corrected. Six words, not free text: the reason is what a month-end query
 *  groups by, and "spoilt", "spoiled" and "Spoilt" would be three answers to one question.
 *  `count` is the physical count - a correction to a sum, not a loss. */
export const AdjustReasonSchema = z.enum(["wastage", "breakage", "expired", "count", "returned_to_vendor", "other"]);
/** Signed: negative wrote stock off, positive counted it up. One line per item, folded by the
 *  service before anything is checked, so what is stored is what actually moved. */
export const AdjustmentLineSchema = z.object({ it: z.string(), qty: Qty });
/** The document behind an `adjustment` move - who corrected which shelf, why, and when. Before
 *  this there was no document at all: the runbook's answer was hand-written SQL, which leaves
 *  the books balanced and the reason nowhere. `loc` is a `StockLoc` because quarantine is a
 *  shelf that has to be correctable - a consignment turned away and later destroyed or sent
 *  back to the vendor leaves quarantine, and nothing else can take it off. */
export const AdjustmentSchema = z.object({
  id: z.string(), loc: StockLocSchema, reason: AdjustReasonSchema, note: z.string(),
  by: z.string(), at: IsoTime, lines: z.array(AdjustmentLineSchema),
});

// ---- adjustment requests (the counter raises, the outlet manager decides)
/** A counter's ask to correct its own shelf, decided by the outlet manager rather than acted on
 *  by the counter directly - the same authorise/act split every other movement keeps, except
 *  there is no second step after "Approved": approving one *is* the correction (CLAUDE.md's
 *  movement rule is written for a hand-off, and a write-off or a count-up has none). */
export const AdjReqStatusSchema = z.enum(["Request sent", "Approved", "Rejected", "Cancelled"]);
export const AdjustmentRequestSchema = z.object({
  id: z.string(), loc: LocKeySchema, reason: AdjustReasonSchema, note: z.string(),
  by: z.string(), at: IsoTime, lines: z.array(AdjustmentLineSchema), st: AdjReqStatusSchema,
  hist: z.array(HistEntrySchema), apprBy: z.string().optional(),
  // The document this became once the manager approved it - the register carries the movement
  // under this id, not under the request's own.
  adjId: z.string().optional(),
});
