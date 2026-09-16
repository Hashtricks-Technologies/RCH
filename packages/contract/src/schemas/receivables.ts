import { z } from "zod";
import { IsoTime, Money } from "./common.js";
import { BillPartySchema, PayerKindSchema, PayerSchema } from "./documents.js";

/**
 * What a party is charged, and what they owe.
 *
 * Two halves that have to stay one thing. The **rate card** decides what comes off a bill and
 * how much a person may owe at once; the **settlement** is what brings the owing back down.
 * Both are the outlet manager's. The register of people they point at is the super admin's
 * (`schemas/admin.ts`), for the same reason staff accounts are: who exists is an identity
 * question, what they are charged is a commercial one.
 */

// ---- the rate card ----------------------------------------------------------------

/** A discount is a percentage of the bill, never a rupee amount: the outlets sell a few hundred
 *  products at prices the manager moves whenever a cost does, and a rupee concession would have
 *  to be re-set every time one did. Two decimals, because 12.5% is a real rate. */
export const DiscountPctSchema = z.number().min(0).max(100).multipleOf(0.01);
/** What one category is charged, and how far it may run. `limit: null` is "no ceiling" and is
 *  the honest default for a consultant nobody wants the till arguing with - it is not the same
 *  as 0, which would refuse every credit sale. */
export const ClassTermsSchema = z.strictObject({
  cls: BillPartySchema, pct: DiscountPctSchema, limit: Money.nullable(),
});
/** One person's exception to their category. Either field may be `null`, meaning "inherit" -
 *  which is why this is not simply `ClassTermsSchema` with a payer on it. A doctor on the
 *  category discount but with a ceiling of their own is the common case. */
export const PayerTermsSchema = z.strictObject({
  kind: PayerKindSchema, id: z.string(), name: z.string(),
  pct: DiscountPctSchema.nullable(), limit: Money.nullable(),
});
/** The whole rate card, as the till and the manager's screen both read it. */
export const TermsSchema = z.strictObject({
  classes: z.array(ClassTermsSchema), payers: z.array(PayerTermsSchema),
});

export const ClassParamsSchema = z.strictObject({ cls: BillPartySchema });
export const PayerParamsSchema = z.strictObject({ kind: PayerKindSchema, id: z.string().min(1).max(64) });
/** Both fields are required and nullable rather than optional: this is a PUT of one row of the
 *  rate card, so "leave it as it is" is not a thing the caller can mean. `null` clears a
 *  ceiling; on a payer it also clears the exception back to the category. */
export const SetClassTermsBodySchema = z.strictObject({
  pct: DiscountPctSchema, limit: Money.nullable(),
});
export const SetPayerTermsBodySchema = z.strictObject({
  pct: DiscountPctSchema.nullable(), limit: Money.nullable(),
});

// ---- who owes what ----------------------------------------------------------------

/** One line of the manager's receivables list. Every figure here is derived from bills and
 *  settlements at read time - there is no stored balance to drift, the same stance the
 *  procurement list takes. */
export const ReceivableSchema = z.strictObject({
  kind: PayerKindSchema, id: z.string(), name: z.string(),
  /** Whether the register still lists them. A deactivated payer who still owes money has to
   *  stay on this screen, or the debt becomes unfindable. */
  active: z.boolean(),
  charged: Money, settled: Money, outstanding: Money,
  /** How many bills are still open, and when the oldest of them was taken - what turns a
   *  balance into a conversation. Absent when nothing is open. */
  bills: z.number().int(), oldest: IsoTime.optional(),
  /** What the rate card says about them today, so the list can show a doctor on 25% beside one
   *  on the category's 20% without a second read. */
  pct: DiscountPctSchema, limit: Money.nullable(),
});
export const ReceivablesResponseSchema = z.array(ReceivableSchema);

/** One open bill on a statement. `owed` is the bill's own total less whatever settlements have
 *  already been allocated to it, so a part-settled bill reads as the part that is left. */
export const StatementBillSchema = z.strictObject({
  no: z.string(), loc: z.string(), at: IsoTime, total: Money, settled: Money, owed: Money,
});
export const SettlementModeSchema = z.enum(["Cash", "UPI", "Card", "Bank transfer", "Payroll deduction"]);
export const SettlementLineSchema = z.strictObject({ no: z.string(), amount: Money });
export const SettlementSchema = z.strictObject({
  id: z.string(), payer: PayerSchema, amount: Money, mode: SettlementModeSchema,
  note: z.string().optional(), at: IsoTime, by: z.string(),
  /** Which bills it closed, and by how much. Stored, not derived: the allocation is a decision
   *  the server made at one instant against the bills open then, and re-deriving it later
   *  against a different set of open bills would answer differently. */
  lines: z.array(SettlementLineSchema),
  voided: z.boolean().optional(), voidReason: z.string().optional(),
});
export const SettlementsResponseSchema = z.array(SettlementSchema);
/** One party's statement: what is still open and what has been paid. */
export const StatementSchema = z.strictObject({
  kind: PayerKindSchema, id: z.string(), name: z.string(),
  outstanding: Money, limit: Money.nullable(), pct: DiscountPctSchema,
  open: z.array(StatementBillSchema), settlements: z.array(SettlementSchema),
});

export const RecordSettlementBodySchema = z.strictObject({
  kind: PayerKindSchema, id: z.string().min(1).max(64),
  /** Positive, and capped well above any month a hospital canteen could run up: a settlement
   *  bigger than the balance is refused by the service with a sentence naming the balance, so
   *  the schema only has to keep a typo out of the transaction. */
  amount: z.number().positive().max(10_000_000),
  mode: SettlementModeSchema,
  note: z.string().max(500).default(""),
});
export const SettlementIdParamsSchema = z.strictObject({ id: z.string().min(1).max(40) });
export const VoidSettlementBodySchema = z.strictObject({ reason: z.string().max(500) });
