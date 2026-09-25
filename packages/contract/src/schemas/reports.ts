import { z } from "zod";
import { IsoTime, Money, Qty, StockLocSchema } from "./common.js";
import { PayerKindSchema, WastageSchema } from "./documents.js";

export const StockLedgerQuerySchema = z.strictObject({
  /** Defaulted, and not because a caller should omit it: `apps/api/src/contract.test.ts` probes
   *  every param-less GET in the manifest with a bare URL, and a required query would make that
   *  probe a 400. The central store is the report's home screen, so it is also its default. */
  loc: StockLocSchema.default("store"),
  /** One window parameter, not a `from` and a `to`: one thing a caller puts in a dropdown, one
   *  boundary to compute, one thing to get wrong. A fixed calendar month, if anybody ever needs
   *  one, is a second query rather than a fourth parameter on this one. */
  days: z.coerce.number().int().min(1).max(365).default(30),
});
export const StockLedgerRowSchema = z.object({ it: z.string(), opening: Qty, recd: Qty, issued: Qty, closing: Qty });
export const StockLedgerResponseSchema = z.strictObject({
  /** `from` and `to` come back so the report's foot can print what it actually measured rather
   *  than what the screen asked for. */
  loc: StockLocSchema, from: IsoTime, to: IsoTime, rows: z.array(StockLedgerRowSchema),
});

// ---- the kitchen's raw materials and packaging. Not stocked there - what lands is used on
// landing - so the kitchen's screen reports what it was issued and what it threw away instead of
// an on-hand figure.
export const KitchenReportQuerySchema = z.strictObject({
  /** Today (1), the last week or the last month - the three windows the screen offers. Defaulted
   *  for the same reason `StockLedgerQuerySchema.days` is: `contract.test.ts` probes it bare. */
  days: z.coerce.number().int().min(1).max(90).default(1),
});
/** One raw or packing line issued to the kitchen over the window: what landed, and its value at
 *  the item's standard cost. */
export const KitchenIssuedRowSchema = z.object({ it: z.string(), qty: Qty, value: Money });
export const KitchenReportSchema = z.strictObject({
  from: IsoTime, to: IsoTime,
  issued: z.array(KitchenIssuedRowSchema),
  /** Newest first. */
  wastage: z.array(WastageSchema),
});

export const CreditParamsSchema = z.strictObject({ kind: PayerKindSchema, id: z.string().min(1).max(64) });
/**
 * What one party owes the hospital right now.
 *
 * It used to be a calendar-month figure, because there was nothing that could bring a balance
 * down except voiding the bill on the day it was taken. Now that a settlement exists, the
 * number that decides a sale is what is **unsettled** - charged less paid, over all time - so a
 * doctor who clears their account on the 15th can go on buying coffee on the 16th. There is no
 * window to report any more, which is why `since` is gone.
 */
export const CreditResponseSchema = z.strictObject({
  kind: PayerKindSchema, id: z.string(), name: z.string(),
  outstanding: Money,
  /** The ceiling the outlet manager set for this party, or `null` for none - a consultant the
   *  hospital does not want the till arguing with. `room` is `null` for exactly the same reason:
   *  a screen prints "no limit" rather than a number nobody set. */
  limit: Money.nullable(),
  room: Money.nullable(),
});

// ---- the register: X and Z -------------------------------------------------------------------
//
// An X-report is the takings so far and changes nothing; a Z-report closes the outlet's session
// and opens the next. Both answer the same shape, so one screen and one printed slip serve both
// and the only difference a reader sees is the heading and whether there is a Z number on it.
//
// The figures are modelled on the hospital's own Z report. Where a line exists there that this
// system does not yet produce a value for, it is carried here as a zero rather than left out: the
// slip then matches the one the counters already read, and filling a line in later is a service
// change rather than a new field on the wire. `nonChargeable` is the one line deliberately absent
// - free issue to employees is a third of their gross and needs a model of its own first.

/** What a tender took, named exactly as the till names it. */
export const TenderLineSchema = z.object({ tender: z.string(), amount: Money, bills: z.number().int() });
/** Money taken during this session against bills from an earlier one - the hospital's "Old Bills"
 *  lines. It is collection, not sale, so it is never added to nett sales. */
export const OldBillLineSchema = z.object({ mode: z.string(), amount: Money });

export const RegisterTotalsSchema = z.object({
  // ---- what was sold
  grossSales: Money, discount: Money, nettSales: Money, creditSales: Money,
  voidAmount: Money, voidBills: z.number().int(),
  // ---- the lines the hospital's slip prints that we have no value for yet. Always zero today.
  tip: Money, parcelCharge: Money, deliveryCharge: Money, additionalCharge: Money,
  complimentary: Money, unCollected: Money, unCollectedDiscount: Money,
  // ---- what was collected
  tenders: z.array(TenderLineSchema), collected: Money,
  oldBills: z.array(OldBillLineSchema), oldBillsTotal: Money,
  // ---- tax, split the way a GST slip prints it
  sgst: Money, cgst: Money, taxTotal: Money,
  // ---- counts
  billCount: z.number().int(),
});

export const RegisterReportSchema = z.strictObject({
  kind: z.enum(["X", "Z"]),
  /** Absent on an X: an open session has no number, because the number is the Z. */
  zNo: z.string().nullable(),
  sessionId: z.string(),
  loc: StockLocSchema,
  /** The session this one follows, so a reader can chain Z to Z without arithmetic on clocks. */
  previousZNo: z.string().nullable(),
  openedAt: IsoTime, closedAt: IsoTime.nullable(),
  /** When the report was produced. On a Z this equals `closedAt`; on an X it is simply now. */
  takenAt: IsoTime, takenBy: z.string(),
  totals: RegisterTotalsSchema,
});
export const RegisterReportsResponseSchema = z.array(RegisterReportSchema);
/** Which outlet's register. Omitted, it is the caller's own - the only choice a counter has. */
export const RegisterQuerySchema = z.strictObject({ loc: StockLocSchema.optional() });
export const CloseRegisterBodySchema = z.strictObject({
  loc: StockLocSchema,
  /** Counted cash in the drawer, if the counter counted it. The slip prints the difference
   *  against what the till says was taken; neither figure is changed by the other. */
  countedCash: Money.optional(),
  note: z.string().max(500).default(""),
});
export const ZReportsQuerySchema = z.strictObject({
  loc: StockLocSchema.optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

// ---- shifts: one operator's stint at one counter ----------------------------------------------
//
// A register session is the outlet's day (Z to Z); a shift is one person's hours inside it. It
// opens when a counter operator signs in at a counter and closes when they press Close Shift (or,
// automatically, when they next sign in at a different counter). The report is only what that
// operator billed at that counter in that window - no counted cash, because the hand-over is of
// the amounts billed, not of a drawer.

export const ShiftTotalsSchema = z.object({
  billCount: z.number().int(),
  grossSales: Money, discount: Money, nettSales: Money, taxTotal: Money,
  /** One line per tender the till has, in `TenderSchema`'s order, whether or not it took anything. */
  tenders: z.array(TenderLineSchema),
  collected: Money, creditSales: Money,
  voidAmount: Money, voidBills: z.number().int(),
});
export const ShiftReportSchema = z.strictObject({
  id: z.string(),
  loc: StockLocSchema,
  userId: z.string(),
  /** The operator's name as it stood on the account when the report was read. */
  operator: z.string(),
  openedAt: IsoTime,
  /** `null` while the shift is still open - the live report. */
  closedAt: IsoTime.nullable(),
  /** The end of the window the figures cover: `closedAt` once closed, the moment of reading before. */
  takenAt: IsoTime,
  /** Closed by the server rather than by the operator: they signed in at another counter with this one still open. */
  auto: z.boolean(),
  totals: ShiftTotalsSchema,
});
/** `shift` is `null` when this session has no open shift at its counter. */
export const CurrentShiftResponseSchema = z.strictObject({ shift: ShiftReportSchema.nullable() });
export const ShiftReportsResponseSchema = z.array(ShiftReportSchema);
export const ShiftsQuerySchema = z.strictObject({
  /** The manager's outlet filter. A counter always reads its own shifts, wherever they were. */
  loc: StockLocSchema.optional(),
  days: z.coerce.number().int().min(1).max(90).default(7),
});
