import { z } from "zod";

export const LocKeySchema = z.enum(["store", "kitchen", "rest", "coffee", "kiosk"]);
export const RoleSchema = z.enum(["counter", "manager", "store", "prod", "buyer"]);
export const ItemTypeSchema = z.enum(["RAW", "PACK", "MRP", "FG", "MTO"]);
export const PriceListSchema = z.enum(["A", "B"]);
/** The six ways a bill is settled — a closed set, not free text. Three of them post to
 *  somebody's account rather than take money at the till (`NEEDS_PAYER` in the pos service),
 *  and the counter's own tender buttons are this list read straight off the schema. */
export const TenderSchema = z.enum(["Cash", "UPI", "Card", "Patient bill", "Staff credit", "Dept"]);
export const ErrorCodeSchema = z.enum(["validation", "unauthenticated", "forbidden", "not_found", "conflict", "rule", "rate_limited", "not_ready", "internal"]);
export const ErrorEnvelopeSchema = z.object({
  error: z.object({ code: ErrorCodeSchema, message: z.string(), details: z.unknown().optional() }),
});
export const OkResponseSchema = z.object({ ok: z.literal(true) });
/** Quantities and money travel as JSON numbers. */
export const Qty = z.number().finite();
export const Money = z.number().finite();
/** Times on the wire are ISO 8601 strings; the UI formats them (Task 16). */
export const IsoTime = z.string();
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The ceiling one staff member may run up on credit inside one calendar month, in rupees.
 *  The rule that reads it is `breachesCredit` in @rch/domain; this is only the number. */
export const STAFF_CREDIT_LIMIT = 3000;

/** The rejected-goods shelf: a Store-type location that never sells and never issues, holding
 *  what quality control turned away at a goods receipt (spec §7.2). */
export const QUARANTINE = "quarantine";
/**
 * Where stock is *reported*. `LocKeySchema` above — the five places an operator works — stays
 * exactly as it is: no write body, no user's home location and neither end of a ticket may ever
 * name quarantine, so widening `LocKey` would have opened six doors to a location nobody can
 * reach and needed a refusal sentence at each. Stock has to be shown there; nothing else does.
 */
export const StockLocSchema = z.enum([...LocKeySchema.options, QUARANTINE]);

// `LocKey` itself is declared in ../types.js, which imports *from* this file — naming it there
// would be a cycle, so the two lists below take a local alias of the same inference.
type LocKey = z.infer<typeof LocKeySchema>;
/** The five places an operator works, in the order the sidebar and every stock screen list them.
 *  Spread out of `LocKeySchema` rather than typed out again, so the two can never disagree — and
 *  kept as `LocKey[]` rather than the schema's `readonly` tuple, because the call sites do
 *  `ALL_LOCS.includes(l)` with a `LocKey` and a narrowed tuple type refuses that. */
export const ALL_LOCS: LocKey[] = [...LocKeySchema.options];
/** The three that sell. `sales`'s columns are these, in this order (readers/documents.ts). */
export const OUTLETS: LocKey[] = ["rest", "coffee", "kiosk"];
/** The order value above which a purchase order needs finance approval, in rupees. The rule
 *  that reads it is `needsApproval` in @rch/domain; this is only the number. */
export const PO_APPROVAL_LIMIT = 25000;
