import { z } from "zod";

export const LocKeySchema = z.enum(["store", "kitchen", "rest", "coffee", "kiosk"]);
export const RoleSchema = z.enum(["counter", "manager", "store", "prod", "buyer"]);
export const ItemTypeSchema = z.enum(["RAW", "PACK", "MRP", "FG", "MTO"]);
export const PriceListSchema = z.enum(["A", "B"]);
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
