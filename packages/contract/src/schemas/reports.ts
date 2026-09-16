import { z } from "zod";
import { IsoTime, Money, Qty, StockLocSchema } from "./common.js";
import { PayerKindSchema } from "./documents.js";

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
