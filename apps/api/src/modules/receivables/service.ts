// Receivables: what each party is charged, what they owe, and what settles it.
//
// service.ts holds the flow. Three of its four writes touch no ledger, no document and no
// balance - a rate is a row and a settlement is a document of its own - so the server-wide lock
// order (documents -> ids -> balances) has nothing to order here. What each write does take is
// the one lock that matters for the thing it changes: the rate card's own row `FOR UPDATE`, or
// `lockPayerCredit` on the person whose balance is moving, which is the same lock a credit sale
// takes. A payment and a sale racing without it would allocate the same bill twice.
import type { z } from "zod";
import type {
  ClassTerms, PayerParamsSchema, PayerTerms, Receivable, RecordSettlementBodySchema,
  Settlement, SettlementMode, Statement, VoidSettlementBodySchema, WriteResponse,
} from "@rch/contract";
import {
  allocateSettlement, can, creditLimitFor, creditLimitRefusal, discountPctFor, discountRefusal,
  dmy, istDate, money as inr, nothingOwedMessage, PARTY_LABEL, settlementOverpayMessage,
  validCreditLimit, validDiscountPct,
} from "@rch/domain";
import type { Db } from "../../db/client.js";
import { auditBefore } from "../../lib/audit.js";
import { openBillsFor, lockPayerCredit, outstandingFor, settlementLinesOf } from "../../lib/credit.js";
import { withReadTransaction, withTransaction } from "../../lib/db.js";
import { emitChanged } from "../../lib/events.js";
import { allocateId } from "../../lib/ids.js";
import { NotFoundError } from "../../lib/errors.js";
import { assertRule } from "../../lib/rules.js";
import { readTerms, termsFor } from "../../lib/terms.js";
import { iso } from "../../lib/time.js";
import type { AccessClaims } from "../../plugins/auth.js";
import type { Actor } from "../../plugins/rbac.js";
import { receivablesRepo as repo, type SettlementRow } from "./repo.js";

/** The allocation rows come back keyed by settlement so one read serves a whole page of them;
 *  the wire shape is the pair alone, and `SettlementSchema` is strict about it. */
const linesOf = (all: { settlementId: string; no: string; amount: number }[], id: string) =>
  all.filter((l) => l.settlementId === id).map((l) => ({ no: l.no, amount: l.amount }));

export type PayerParams = z.infer<typeof PayerParamsSchema>;
export type RecordSettlementBody = z.infer<typeof RecordSettlementBodySchema>;
export type VoidSettlementBody = z.infer<typeof VoidSettlementBodySchema>;

/** How many payments the Settlements tab lists. A screen that carries every payment the hospital
 *  has ever taken is a screen nobody scrolls; one party's whole history is on their statement. */
const SETTLEMENT_FEED = 200;

const money = (n: number): number => Math.round(n * 100) / 100;

/** The wire shape of a settlement, with the manager's name rather than their id and its own
 *  allocation attached. `voided`/`voidReason` are dropped on the overwhelming majority, the way
 *  a bill's are. */
function toWireSettlement(r: SettlementRow, by: string, lines: { no: string; amount: number }[]): Settlement {
  return {
    id: r.id,
    payer: { kind: r.kind, id: r.payerId, name: r.payerName },
    amount: r.amount, mode: r.mode as SettlementMode,
    ...(r.note ? { note: r.note } : {}),
    at: iso(r.at), by, lines,
    ...(r.voidedAt ? { voided: true, voidReason: r.voidReason ?? "" } : {}),
  };
}

export function createReceivablesService(db: Db) {
  return {
    // ---- the rate card -------------------------------------------------------------------

    /**
     * What a whole category is charged, and how far it may run.
     *
     * The row is locked first and read for its before values, so two managers saving the
     * doctors' rate in the same instant queue rather than overwrite each other, and a refused
     * save still carries what it was going to change (`auditBefore`, root CLAUDE.md).
     */
    async setClassTerms(claims: AccessClaims, cls: ClassTerms["cls"], body: { pct: number; limit: number | null }): Promise<WriteResponse<ClassTerms>> {
      return withTransaction(db, async (tx) => {
        const before = await repo.classHead(tx, cls);
        if (!before) throw new NotFoundError(`There is no ${PARTY_LABEL[cls]} rate to change.`);
        auditBefore({ cls, pct: before.pct, limit: before.limit });

        assertRule(validDiscountPct(body.pct), discountRefusal(body.pct));
        assertRule(validCreditLimit(body.limit), creditLimitRefusal(body.limit ?? 0));

        const at = new Date();
        await repo.saveClass(tx, cls, { pct: body.pct, limit: body.limit, by: claims.sub, at });
        const result: ClassTerms = { cls, pct: body.pct, limit: body.limit };
        // Said as the operator would say it: the rate first, because that is what changes a
        // bill, and the ceiling only where there is one to speak of.
        const ceiling = body.limit === null ? "no credit limit" : `a ${inr(body.limit)} credit limit`;
        // Both: the rate card itself, which every till prices against, and the receivables list,
        // whose every row prints the rate and the ceiling this just moved.
        const changed = ["terms", "receivables"] as const;
        await emitChanged(tx, changed);
        return {
          result, changed: [...changed],
          message: `Every ${PARTY_LABEL[cls]} now gets ${body.pct}% off, with ${ceiling}`,
        };
      });
    },

    /**
     * And one person's exception to it. `null` in either field means "inherit", and an exception
     * that inherits both is removed rather than kept as a row of two nulls - so the manager's
     * list of exceptions is the exceptions and nothing else.
     */
    async setPayerTerms(claims: AccessClaims, p: PayerParams, body: { pct: number | null; limit: number | null }): Promise<WriteResponse<PayerTerms>> {
      return withTransaction(db, async (tx) => {
        const payer = await repo.payer(tx, p.kind, p.id);
        if (!payer) throw new NotFoundError(`There is nobody on the roster with the number ${p.id}.`);
        const before = await repo.payerHead(tx, p.kind, p.id);
        auditBefore({ kind: p.kind, id: p.id, name: payer.name, pct: before?.pct ?? null, limit: before?.limit ?? null });

        assertRule(body.pct === null || validDiscountPct(body.pct), discountRefusal(body.pct ?? 0));
        assertRule(validCreditLimit(body.limit), creditLimitRefusal(body.limit ?? 0));

        const at = new Date();
        if (body.pct === null && body.limit === null) await repo.dropPayerTerms(tx, p.kind, p.id);
        else await repo.savePayer(tx, p.kind, p.id, { pct: body.pct, limit: body.limit, by: claims.sub, at });

        const result: PayerTerms = { kind: p.kind, id: p.id, name: payer.name, pct: body.pct, limit: body.limit };
        // What they will actually be charged, not what was typed: an exception of `null` reads
        // as the category's own rate, and saying "null% off" would be no use to anybody.
        const effective = await termsFor(tx, p.kind, { kind: p.kind, id: p.id });
        const ceiling = effective.limit === null ? "no credit limit" : `a ${inr(effective.limit)} credit limit`;
        const changed = ["terms", "receivables"] as const;
        await emitChanged(tx, changed);
        return {
          result, changed: [...changed],
          message: body.pct === null && body.limit === null
            ? `${payer.name} is back on the ${PARTY_LABEL[p.kind]} rate - ${effective.pct}% off, with ${ceiling}`
            : `${payer.name} now gets ${effective.pct}% off, with ${ceiling}`,
        };
      });
    },

    // ---- who owes what -------------------------------------------------------------------

    /**
     * Every party with an account, what they owe and what they are on.
     *
     * Derived at read time from bills and settlements - there is no stored balance to drift, the
     * same stance the procurement list takes. A party who owes nothing is still here as long as
     * the register lists them or they have ever been charged, because "who owes nothing" is half
     * of what this screen is for.
     *
     * Four reads in sequence inside one read transaction, so the whole report costs one pool
     * connection rather than four (`lib/db.ts`).
     */
    async receivables(actor: Actor): Promise<Receivable[]> {
      // Anybody whose role does not hold Receivables & settlements reads an empty list, and reads
      // it without touching the database. The route is "any" so that a settlement's notice does not
      // 403 every other role mid-refetch (`routes.ts` in @rch/contract says why); this is the cut
      // that makes that safe. `credit` alone - the rate card - is not enough: who owes what is the
      // settlements desk's. Of the seeded roles only the outlet manager holds `settlements`, so it
      // answers exactly as the manager-only check before it did.
      if (!can(actor.perms, "settlements")) return [];
      return withReadTransaction(db, async (tx) => {
        const charged = await repo.chargedByPayer(tx);
        const settled = await repo.settledByPayer(tx);
        const register = await repo.allPayers(tx);
        const terms = await readTerms(tx);

        const byCls = new Map(terms.classes.map((c) => [c.cls, c]));
        const own = new Map(terms.payers.map((t) => [`${t.kind}:${t.id}`, t]));
        const chargedBy = new Map(charged.map((c) => [`${c.kind}:${c.id}`, c]));
        const settledBy = new Map(settled.map((s) => [`${s.kind}:${s.id}`, s.settled]));

        // The register, plus anybody charged who is no longer on it. A payer deleted from the
        // roster cannot happen - they are switched off, never removed - but a charged party with
        // no register row is exactly the case where a balance would otherwise go missing, so it
        // is carried rather than dropped.
        const seen = new Set(register.map((p) => `${p.kind}:${p.id}`));
        const rows = [
          ...register,
          ...charged.filter((c) => !seen.has(`${c.kind}:${c.id}`)).map((c) => ({ ...c, name: c.id, active: false })),
        ];

        return rows.map((p): Receivable => {
          const key = `${p.kind}:${p.id}`;
          const c = chargedBy.get(key);
          const cls = byCls.get(p.kind);
          const mine = own.get(key);
          const paid = settledBy.get(key) ?? 0;
          const total = c?.charged ?? 0;
          return {
            kind: p.kind, id: p.id, name: p.name, active: p.active,
            charged: total, settled: paid, outstanding: Math.max(0, money(total - paid)),
            bills: c?.bills ?? 0,
            ...(c?.oldest ? { oldest: iso(c.oldest) } : {}),
            pct: discountPctFor(cls?.pct ?? 0, mine?.pct),
            limit: creditLimitFor(cls?.limit ?? null, mine?.limit),
          };
        }).sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name));
      });
    },

    /** One party's statement: the bills still open and every payment they have made. */
    async statement(p: PayerParams): Promise<Statement> {
      return withReadTransaction(db, async (tx) => {
        const payer = await repo.payer(tx, p.kind, p.id);
        if (!payer) throw new NotFoundError(`There is nobody on the roster with the number ${p.id}.`);
        const { outstanding } = await outstandingFor(tx, p.kind, p.id);
        const terms = await termsFor(tx, p.kind, { kind: p.kind, id: p.id });
        const open = await openBillsFor(tx, p.kind, p.id);
        const rows = await repo.settlementsOf(tx, p.kind, p.id);
        const lines = await repo.linesOf(tx, rows.map((r) => r.id));
        const names = await repo.userNames(tx, [...new Set(rows.map((r) => r.by))]);
        return {
          kind: p.kind, id: p.id, name: payer.name,
          outstanding, limit: terms.limit, pct: terms.pct,
          open: open.map((b) => ({ no: b.no, loc: b.loc, at: iso(b.at), total: b.total, settled: b.settled, owed: b.owed })),
          settlements: rows.map((r) => toWireSettlement(r, names.get(r.by) ?? r.by, linesOf(lines, r.id))),
        };
      });
    },

    /** Everybody's recent payments, for the Settlements tab. Cut exactly like `receivables`. */
    async settlements(actor: Actor): Promise<Settlement[]> {
      if (!can(actor.perms, "settlements")) return [];
      return withReadTransaction(db, async (tx) => {
        const rows = await repo.recentSettlements(tx, SETTLEMENT_FEED);
        const lines = await repo.linesOf(tx, rows.map((r) => r.id));
        const names = await repo.userNames(tx, [...new Set(rows.map((r) => r.by))]);
        return rows.map((r) => toWireSettlement(r, names.get(r.by) ?? r.by, linesOf(lines, r.id)));
      });
    },

    // ---- settling ------------------------------------------------------------------------

    /**
     * Somebody paid against what they owe.
     *
     * The payment is laid over their open bills oldest first (`allocateSettlement`,
     * @rch/domain), and the allocation is **stored**: it is a decision made at one instant
     * against the bills open then, and re-deriving it a week later against a different set of
     * open bills would answer differently.
     *
     * More than the balance is refused rather than parked as a credit balance. A hospital
     * canteen has no use for one, and a payment bigger than the debt is a typed figure nobody
     * meant - the refusal names what is actually owed so it can be corrected without going to
     * look.
     */
    async record(claims: AccessClaims, body: RecordSettlementBody): Promise<WriteResponse<Settlement>> {
      return withTransaction(db, async (tx) => {
        const payer = await repo.payer(tx, body.kind, body.id);
        if (!payer) throw new NotFoundError(`There is nobody on the roster with the number ${body.id}.`);

        // The same lock a credit sale takes, before either number is read. Without it a payment
        // and a sale in the same instant both see the bills that existed before either wrote,
        // and the payment allocates against a set that is already stale.
        await lockPayerCredit(tx, body.kind, body.id);
        const { outstanding } = await outstandingFor(tx, body.kind, body.id);
        assertRule(outstanding > 0, nothingOwedMessage(payer.name));

        const amount = money(body.amount);
        assertRule(amount <= outstanding, settlementOverpayMessage(amount, outstanding, payer.name));

        const open = await openBillsFor(tx, body.kind, body.id);
        const { lines, left } = allocateSettlement(
          open.map((b) => ({ no: b.no, at: b.at.toISOString(), owed: b.owed })), amount,
        );
        // Belt and braces against the two halves disagreeing: `outstanding` is a sum over bills
        // and `open` is those same bills row by row, so anything left over means the two reads
        // saw different things and this payment would go partly nowhere.
        assertRule(left === 0, settlementOverpayMessage(amount, money(amount - left), payer.name));

        const at = new Date();
        const id = await allocateId(tx, "settlement", at);
        const head = await repo.insertSettlement(tx, {
          id, kind: body.kind, payerId: body.id, payerName: payer.name,
          amount, mode: body.mode, note: body.note.trim(), at, by: claims.sub,
        });
        await repo.insertSettlementLines(tx, id, lines);

        const names = await repo.userNames(tx, [claims.sub]);
        const result = toWireSettlement(head, names.get(claims.sub) ?? claims.sub, lines);
        const nowOwes = money(outstanding - amount);
        const changed = ["receivables"] as const;
        await emitChanged(tx, changed);
        return {
          result, changed: [...changed],
          message: nowOwes > 0
            ? `${id} · ${inr(amount)} from ${payer.name} against ${lines.length} bill${lines.length === 1 ? "" : "s"} - ${inr(nowOwes)} still owed`
            : `${id} · ${inr(amount)} from ${payer.name} - the account is clear`,
        };
      });
    },

    /**
     * Take a mis-keyed payment back, on the day it was taken and no later.
     *
     * The same shape and the same reasoning as a bill's void (`modules/pos`): the row stays
     * exactly as it was recorded, badged rather than erased, and every sum that counts money
     * learns to skip it - which for a settlement means its allocation stops closing the bills it
     * closed, so they reopen and the balance comes back. There is nothing to un-post: the
     * allocation is read through `voided_at is null`, so voiding it is the whole of the reversal.
     */
    async voidSettlement(claims: AccessClaims, id: string, body: VoidSettlementBody): Promise<WriteResponse<Settlement>> {
      return withTransaction(db, async (tx) => {
        // The document first, locked - the order every write in this server keeps. Two managers
        // pressing Void on the same payment queue here, and the second reads what the first wrote.
        const row = await repo.headForUpdate(tx, id);
        if (!row) throw new NotFoundError(`There is no settlement ${id}.`);

        const reason = body.reason.trim();
        assertRule(reason.length > 0, "Give a reason for voiding this settlement");
        assertRule(!row.voidedAt, `${id} has already been voided`);

        const at = new Date();
        assertRule(istDate(row.at) === istDate(at),
          `${id} was taken on ${dmy(istDate(row.at))} - a settlement can only be voided on the day it was recorded; record a correcting payment instead`);

        // And the balance it is about has to hold still while it moves, the same as when it was
        // taken: a sale committing against a balance this void is about to raise would be priced
        // against a ceiling that was true for an instant.
        await lockPayerCredit(tx, row.kind, row.payerId);

        const head = await repo.setVoided(tx, id, { at, by: claims.sub, reason });
        const lines = await settlementLinesOf(tx, id);
        const names = await repo.userNames(tx, [head.by]);
        const result = toWireSettlement(head, names.get(head.by) ?? head.by, lines);
        const { outstanding } = await outstandingFor(tx, row.kind, row.payerId);
        const changed = ["receivables"] as const;
        await emitChanged(tx, changed);
        return {
          result, changed: [...changed],
          message: `${id} voided - ${row.payerName} owes ${inr(outstanding)} again`,
        };
      });
    },
  };
}

