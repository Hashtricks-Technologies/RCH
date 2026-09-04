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
export const CreditResponseSchema = z.strictObject({
  kind: PayerKindSchema, id: z.string(), name: z.string(),
  /** Midnight on the first of the month, in the hospital's zone — the window the ceiling is settled over. */
  since: IsoTime,
  taken: Money,
  /** The ceiling only binds `staff`: credit is what the "Staff credit" tender creates and that
   *  tender carries a staff payer. For `patient` and `dept` the same number is reported for
   *  symmetry and `taken` is structurally 0 — the row exists so a screen can say so rather
   *  than having to know which kinds have a ceiling. */
  limit: Money,
  room: Money,
});
