// Register: the flow. An X counts the open session and changes nothing; a Z closes it, numbers
// it and stores what it printed; the Z list reads those stored figures back.
//
// The arithmetic stays in this file rather than in @rch/domain, and deliberately: it is not a
// rule two sides apply, it is the shape of one printed slip - the hospital's own Z - assembled
// from aggregates the database already computed. There is nothing here for a browser to decide
// again.
import type { z } from "zod";
import type { CloseRegisterBodySchema, OldBillLine, RegisterReport, RegisterTotals, TenderLine, WriteResponse } from "@rch/contract";
import { RegisterTotalsSchema, SettlementModeSchema, TenderSchema } from "@rch/contract";
import { ACCOUNT_TENDERS, money as inr } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withReadTransaction, withTransaction, type Reader } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { allocateId } from "../../lib/ids.js";
import { lockLocation } from "../../lib/locations.js";
import { openSessionAt, takeOpenSession } from "../../lib/register.js";
import { assertRule } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { registerRepo, type SoldLine } from "./repo.js";

export type CloseRegisterBody = z.infer<typeof CloseRegisterBodySchema>;

/** Money is stored and read at two decimals; every figure the slip prints is rounded once, here,
 *  rather than at each place that adds two of them together. */
const money = (n: number): number => Math.round(n * 100) / 100;
const isCredit = (tender: string): boolean => (ACCOUNT_TENDERS as readonly string[]).includes(tender);
const sum = (ns: number[]): number => money(ns.reduce((a, b) => a + b, 0));

/**
 * The slip, from what the session's bills and the window's settlements add up to.
 *
 * Every tender the till has gets a line whether or not it took anything, and so does every
 * settlement mode, in the schema's own order. A Z whose rows change shape from one day to the
 * next is a Z nobody can hold against yesterday's, and "Card 0.00" is exactly what the
 * hospital's own slip prints. Anything the data carries that the schema does not is appended
 * rather than dropped, so a tender renamed out of the manifest still shows the money it took -
 * `nettSales` counts it either way, and a total no line accounts for is the one thing a
 * reconciliation must never produce.
 */
function buildTotals(sold: SoldLine[], voided: { amount: number; bills: number }, settled: { mode: string; amount: number }[]): RegisterTotals {
  const byTender = new Map(sold.map((r) => [r.tender, r]));
  const tenders: TenderLine[] = [...new Set<string>([...TenderSchema.options, ...byTender.keys()])]
    .map((tender) => ({ tender, amount: byTender.get(tender)?.amount ?? 0, bills: byTender.get(tender)?.bills ?? 0 }));

  const collected = sum(tenders.filter((t) => !isCredit(t.tender)).map((t) => t.amount));
  const creditSales = sum(tenders.filter((t) => isCredit(t.tender)).map((t) => t.amount));
  // `bills.total` is the net - what the bill is worth and what is owed - so nett is the sum of
  // the tender lines and the gross is that plus what the party's rate card took off.
  const nettSales = money(collected + creditSales);
  const discount = sum(sold.map((r) => r.discount));

  const byMode = new Map(settled.map((r) => [r.mode, r.amount]));
  const oldBills: OldBillLine[] = [...new Set<string>([...SettlementModeSchema.options, ...byMode.keys()])]
    .map((mode) => ({ mode, amount: byMode.get(mode) ?? 0 }));

  // Half and half, and the second half is the remainder rather than a second division: two
  // roundings of an odd number of paise leave a slip whose two GST lines do not add up to its
  // own tax total, which is the first thing an auditor checks.
  const taxTotal = sum(sold.map((r) => r.tax));
  const sgst = money(taxTotal / 2);

  return {
    grossSales: money(nettSales + discount), discount, nettSales, creditSales,
    voidAmount: voided.amount, voidBills: voided.bills,
    // Placeholders, every one of them. The hospital's Z prints these lines and prints them as
    // 0.00, and we match its format so a counter can read the two slips side by side; each
    // becomes a real figure the day the system has something to put in it, as a service change
    // rather than a new field on the wire. `nonChargeable` is deliberately not among them -
    // free issue to employees needs a model of its own first.
    tip: 0, parcelCharge: 0, deliveryCharge: 0, additionalCharge: 0,
    complimentary: 0, unCollected: 0, unCollectedDiscount: 0,
    tenders, collected,
    oldBills, oldBillsTotal: sum(oldBills.map((o) => o.amount)),
    sgst, cgst: money(taxTotal - sgst), taxTotal,
    billCount: sold.reduce((a, r) => a + r.bills, 0),
  };
}

/** What one session took, between the instant it opened and the instant the report is for.
 *  Three reads, one after another on the one client (`withReadTransaction`'s reason). */
async function totalsOf(db: Reader, sessionId: string, from: Date, to: Date): Promise<RegisterTotals> {
  const sold = await registerRepo.soldIn(db, sessionId);
  const voided = await registerRepo.voidedIn(db, sessionId);
  const settled = await registerRepo.settledIn(db, from, to);
  return buildTotals(sold, voided, settled);
}

export function createRegisterService(db: Db) {
  return {
    /**
     * The takings so far at one outlet, and nothing else: an X never writes, never numbers
     * anything and never opens a session. It may be taken as often as anyone likes, and two
     * taken a second apart over a quiet till answer identically.
     *
     * An outlet that has taken nothing since its last Z has no open session at all, and the
     * answer is a well-formed report of zeros rather than a 404 - "nothing has been sold yet"
     * is a fact about the register, not a missing page. What it describes is the session that
     * would be next: no id, because the first sale is what mints one; no takings, because there
     * are none; and the last Z this outlet took, so the reader still knows where the chain is.
     */
    async xReport(claims: AccessClaims, loc: string): Promise<RegisterReport> {
      return withReadTransaction(db, async (tx) => {
        const place = await registerRepo.location(tx, loc);
        if (!place) throw new NotFoundError(`There is no location ${loc}.`);
        const takenAt = new Date();
        const takenBy = await registerRepo.userName(tx, claims.sub);
        const open = await openSessionAt(tx, loc);
        const previousZNo = await registerRepo.lastZ(tx, loc);
        const totals = open
          ? await totalsOf(tx, open.id, open.openedAt, takenAt)
          : buildTotals([], { amount: 0, bills: 0 }, []);
        return {
          kind: "X", zNo: null,
          sessionId: open?.id ?? "",
          loc, previousZNo,
          openedAt: (open?.openedAt ?? takenAt).toISOString(), closedAt: null,
          takenAt: takenAt.toISOString(), takenBy: takenBy ?? claims.sub,
          totals,
        };
      });
    },

    /**
     * Close the outlet's register and take its Z.
     *
     * The session row `FOR UPDATE` is the load-bearing lock of the whole feature: every sale
     * and every void at this outlet holds the same row `FOR SHARE`, so this waits for all of
     * them and nothing can be stamped onto the session between the count and the close. The
     * outlet's own row comes first, as it does in every write that names a location, which
     * keeps the two locks in the one order the sale takes them - outlet, then session - and the
     * cycle a lock order exists to prevent cannot form.
     *
     * It does **not** open the next session. Nothing has been sold into it, so there is nothing
     * for it to hold; the first sale after this opens it (`lib/register.ts`), and an outlet that
     * never reopens is left with no dangling empty day on the books.
     */
    async closeRegister(claims: AccessClaims, body: CloseRegisterBody): Promise<WriteResponse<RegisterReport>> {
      return withTransaction(db, async (tx) => {
        const loc = body.loc;
        // The outlet, in the documents tier, before the session and well before the Z number.
        // No `assertOpen`: a Z takes no new commitment, it accounts for takings already on the
        // books, and refusing one at an outlet the super admin has since closed would strand a
        // day's money with no way to reconcile it.
        const place = await lockLocation(tx, loc);
        const open = await takeOpenSession(tx, loc);
        assertRule(open, `There is nothing to close at ${place.name} - no sale has been taken since the last Z.`);

        const at = new Date();
        const totals = await totalsOf(tx, open.id, open.openedAt, at);
        const previousZNo = await registerRepo.lastZ(tx, loc);
        // The number, after the documents and before nothing at all - a close touches no
        // balance. The series is gapless because a refused close rolls the counter back with
        // everything else, and a gapless series is the whole point of a Z: a missing number is a
        // day nobody can account for.
        const zNo = await allocateId(tx, "z_report", at);
        await registerRepo.close(tx, open.id, { zNo, at, by: claims.sub, totals, countedCash: body.countedCash ?? null, note: body.note });

        const takenBy = await registerRepo.userName(tx, claims.sub);
        const result: RegisterReport = {
          kind: "Z", zNo, sessionId: open.id, loc, previousZNo,
          openedAt: open.openedAt.toISOString(), closedAt: at.toISOString(),
          takenAt: at.toISOString(), takenBy: takenBy ?? claims.sub,
          totals,
        };
        // What the counter has to check before they walk away: what the till says the drawer
        // should hold, and - where they counted it - which way it is out.
        const cash = totals.tenders.find((t) => t.tender === "Cash")?.amount ?? 0;
        const off = money((body.countedCash ?? 0) - cash);
        const drawer = body.countedCash === undefined ? ""
          : off === 0 ? ` · ${inr(body.countedCash)} counted, and the drawer agrees to the paisa`
            : ` · ${inr(body.countedCash)} counted against ${inr(cash)} cash, ${inr(Math.abs(off))} ${off > 0 ? "over" : "short"}`;
        const message = `${zNo} closed the register at ${place.name} - ${inr(totals.nettSales)} nett over ${totals.billCount} ${totals.billCount === 1 ? "bill" : "bills"}, ${inr(totals.collected)} collected${drawer}`;
        // `bills` and nothing else: what a Z changes is which bills are still open to a void and
        // what the till's own day reads, both of which live in that slice. There is no `register`
        // collection on the wire to name.
        const changed = ["bills"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message };
      });
    },

    /**
     * The outlet's past Zs, newest first, **read from what each one stored** rather than worked
     * out again from the bills behind it. A Z is a decision taken at one instant against the
     * bills open then; re-deriving it a week later - after a payer was renamed, after the rate
     * card moved - would answer differently, and a Z that answers differently on Tuesday is not
     * a Z. Nothing can alter a bill once its session is closed, so the stored figures and the
     * bills behind them cannot drift either.
     */
    async zReports(_claims: AccessClaims, loc: string, days: number): Promise<RegisterReport[]> {
      return withReadTransaction(db, async (tx) => {
        const place = await registerRepo.location(tx, loc);
        if (!place) throw new NotFoundError(`There is no location ${loc}.`);
        const since = new Date(Date.now() - days * 86_400_000);
        const rows = await registerRepo.closedSince(tx, loc, since);
        // One read beyond the window's edge, so the oldest Z on the list still says which Z it
        // follows instead of reading as the first the hospital ever took.
        const before = rows.length > 0 ? await registerRepo.zBefore(tx, loc, rows[rows.length - 1].closedAt) : null;
        return rows.map((r, i) => ({
          kind: "Z" as const,
          zNo: r.zNo, sessionId: r.id, loc,
          previousZNo: i + 1 < rows.length ? rows[i + 1].zNo : before,
          openedAt: r.openedAt.toISOString(), closedAt: r.closedAt.toISOString(),
          takenAt: r.closedAt.toISOString(), takenBy: r.closedByName ?? r.closedBy ?? "",
          totals: RegisterTotalsSchema.parse(r.closedTotals),
        }));
      });
    },
  };
}
