import { and, asc, eq } from "drizzle-orm";
import type { BillParty, ClassTerms, PayerKind, Terms } from "@rch/contract";
import { BillPartySchema, STAFF_CREDIT_LIMIT } from "@rch/contract";
import { creditLimitFor, discountPctFor } from "@rch/domain";
import * as s from "../db/schema/index.js";
import type { Db } from "../db/client.js";
import type { Tx } from "./db.js";

/**
 * The rate card: what each party is charged, and how much of it they may owe at once.
 *
 * One reader for four callers - the sale that prices a bill, the till that previews it, the
 * manager's screen that edits it, and the receivables list that prints what each person is on.
 * A screen that showed a rate the sale would not apply is the whole defect this exists to
 * prevent, so nobody else resolves a rate; they call `termsFor` below.
 *
 * Neither table is ever empty of the row a sale needs: migration 0022 seeds every category.
 * `FALLBACK` is what a caller gets if somebody has deleted one anyway, and it is the behaviour
 * this system had before a rate card existed - nothing off, and the staff ceiling it always
 * enforced - so a missing row is a silent no-op rather than a free coffee or a 500.
 */
const FALLBACK: Record<BillParty, { pct: number; limit: number | null }> = {
  customer: { pct: 0, limit: null }, staff: { pct: 0, limit: STAFF_CREDIT_LIMIT },
  doctor: { pct: 0, limit: null }, dept: { pct: 0, limit: null },
};

/** What actually applies to one party, the person's own exception over their category's rate.
 *  `pct` is always a number and `limit` is `null` for no ceiling at all. */
export interface ResolvedTerms { pct: number; limit: number | null }

/**
 * Resolve one party's terms. `payer` is absent for a walk-in customer, which is not a missing
 * payer but a party of its own.
 *
 * Two reads rather than a join, and in this order, because the common case is a party with no
 * exception at all: the category row is the answer, and the second read comes back empty. Both
 * go through the caller's transaction where there is one, so a sale prices against the rate card
 * that transaction commits against.
 */
export async function termsFor(
  db: Db | Tx, party: BillParty, payer?: { kind: PayerKind; id: string },
): Promise<ResolvedTerms> {
  const [cls] = await db.select({ pct: s.payerClassTerms.discountPct, limit: s.payerClassTerms.creditLimit })
    .from(s.payerClassTerms).where(eq(s.payerClassTerms.cls, party));
  const base = cls ?? FALLBACK[party];
  if (!payer) return { pct: base.pct, limit: base.limit };

  const [own] = await db.select({ pct: s.payerTerms.discountPct, limit: s.payerTerms.creditLimit })
    .from(s.payerTerms).where(and(eq(s.payerTerms.kind, payer.kind), eq(s.payerTerms.payerId, payer.id)));
  return {
    pct: discountPctFor(base.pct, own?.pct),
    limit: creditLimitFor(base.limit, own?.limit),
  };
}

/** The whole card, for the snapshot, the narrow read and the manager's screen. The exceptions
 *  carry the payer's name, because a list of `DR-118` with no name beside it is unreadable. */
export async function readTerms(db: Db | Tx): Promise<Terms> {
  const classes = await db.select({
    cls: s.payerClassTerms.cls, pct: s.payerClassTerms.discountPct, limit: s.payerClassTerms.creditLimit,
  }).from(s.payerClassTerms);
  const payers = await db.select({
    kind: s.payerTerms.kind, id: s.payerTerms.payerId, name: s.payers.name,
    pct: s.payerTerms.discountPct, limit: s.payerTerms.creditLimit,
  }).from(s.payerTerms)
    .innerJoin(s.payers, and(eq(s.payers.kind, s.payerTerms.kind), eq(s.payers.id, s.payerTerms.payerId)))
    .orderBy(asc(s.payers.name));

  // Ordered by the enum rather than by whatever the table hands back, so the manager's rate card
  // reads the same way every time it is opened.
  const byCls = new Map(classes.map((c) => [c.cls, c]));
  return {
    classes: BillPartySchema.options.map((cls): ClassTerms => {
      const row = byCls.get(cls);
      return { cls, pct: row?.pct ?? FALLBACK[cls].pct, limit: row?.limit ?? FALLBACK[cls].limit };
    }),
    payers,
  };
}

/** The empty card, for a caller who never takes a bill - the same shape, so a screen that reads
 *  it needs no special case. Mirrors `scopeRoster`. */
export const noTerms = (): Terms => ({ classes: [], payers: [] });
