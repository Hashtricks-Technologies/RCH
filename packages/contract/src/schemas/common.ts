import { z } from "zod";

/**
 * Where an operator acts. A location key is data, not a closed list: the central store and the
 * central kitchen are `STORE` and `KITCHEN` below, and every outlet is a row the super admin opened -
 * so a key is checked for shape here and for existence by the service that reads its row
 * (`apps/api/src/lib/locations.ts`). Lower-case, a letter first, at most 24 characters: the shape
 * `outletKeyFor` in @rch/domain mints. The one key refused by name is the rejected-goods shelf - no
 * write body, no user's home location and neither end of a ticket may ever name quarantine. A
 * lookahead rather than a `.refine`, so this stays a plain string schema a record can be keyed by.
 */
export const LocKeySchema = z.string().regex(/^(?!quarantine$)[a-z][a-z0-9-]{0,23}$/, "Not a location an operator can act at");
export const RoleSchema = z.enum(["counter", "manager", "store", "prod", "buyer"]);
export const ItemTypeSchema = z.enum(["RAW", "PACK", "MRP", "FG", "MTO"]);
/** A price list's id on the wire - server-issued (`formatId("price_list", …)`, e.g. `"PL-006"`),
 *  never a closed set: a manager may create as many named price lists as they want. */
export const PriceListIdSchema = z.string().min(1).max(32);
/** The six ways a bill is settled - a closed set, not free text. Three of them post to
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
 *  what quality control turned away at a goods receipt. */
export const QUARANTINE = "quarantine";
/** Where stock is *reported*: any location key, the rejected-goods shelf included. Stock has to be
 *  shown there; nothing may be sold, issued or moved from there, which `LocKeySchema` holds. */
export const StockLocSchema = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/, "Not a location key");
/** The central store and the central kitchen - one of each in every hospital, and the only two
 *  locations the code may name. Outlets are read from the master, never listed. */
export const STORE = "store";
export const KITCHEN = "kitchen";

/** The order value above which a purchase order needs finance approval, in rupees. The rule
 *  that reads it is `needsApproval` in @rch/domain; this is only the number. */
export const PO_APPROVAL_LIMIT = 25000;
