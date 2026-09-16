import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PayerKind } from "@rch/contract";
import { ACCOUNT_TENDERS } from "@rch/domain";
import * as s from "../db/schema/index.js";
import type { Db } from "../db/client.js";
import type { Tx } from "./db.js";

/**
 * Queue everything that changes one person's balance behind the thing before it.
 *
 * `outstandingFor` below sums rows that are already committed, so two tills reading in the same
 * instant both see the room that existed before either of them wrote - and both fit under a
 * ceiling only one of them fits under. There is no row to lock instead: the read is a sum over
 * bills that do not exist yet. A transaction-scoped advisory lock on the payer is the narrowest
 * thing that serialises exactly that pair, and Postgres releases it when the transaction ends,
 * whichever way it ends.
 *
 * Keyed by kind as well as id, and it has to be: the four registers are numbered independently,
 * so a staff number really can read like a cost centre, and one key for both would queue two
 * unrelated people behind each other. A settlement takes the same lock for the mirror-image
 * reason - a payment and a sale racing would otherwise allocate the same bill twice.
 */
export async function lockPayerCredit(db: Tx, kind: PayerKind, payerId: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit:${kind}:${payerId}`}))`);
}

/**
 * What one payer still owes the hospital: everything charged to their account, less everything
 * settled against it.
 *
 * Three callers, on purpose - `modules/pos` refuses a bill on it, `modules/reports` prints it at
 * the till, and `modules/receivables` builds the manager's list from the same two halves. A
 * report that disagreed with the refusal would be worse than no report.
 *
 * It used to be a calendar-month figure, because nothing could bring a balance down except
 * voiding the bill on the day it was taken. Now that a settlement exists, the month is the wrong
 * window: somebody who cleared their account on the 15th is not still spent up on the 16th.
 *
 * Credit, and only credit: a bill the same person paid cash for in their own name is not credit
 * and must not eat their room, which is what the tender filter is for. The payer kind is part of
 * the filter as well as the tender, because a "Staff credit" posted to a patient would otherwise
 * be a balance no rule measures.
 *
 * Neither a voided bill nor a voided settlement counts. A bill left on the table with its lines
 * intact is not a debt - the void reverses the sale, it does not erase it - and a settlement
 * somebody took back did not happen. Without those two `is null`s a mis-keyed bill would go on
 * eating a person's room for ever, and a mis-keyed payment would go on forgiving a debt.
 */
export async function outstandingFor(
  db: Db | Tx, kind: PayerKind, payerId: string,
): Promise<{ charged: number; settled: number; outstanding: number }> {
  const [row] = await db.select({
    charged: sql<string>`coalesce(sum(${s.bills.total}), 0)`,
  }).from(s.bills)
    .where(and(
      inArray(s.bills.tender, [...ACCOUNT_TENDERS]),
      eq(s.bills.payerKind, kind), eq(s.bills.payerId, payerId), isNull(s.bills.voidedAt),
    ));
  const [paid] = await db.select({
    settled: sql<string>`coalesce(sum(${s.settlements.amount}), 0)`,
  }).from(s.settlements)
    .where(and(eq(s.settlements.kind, kind), eq(s.settlements.payerId, payerId), isNull(s.settlements.voidedAt)));

  const charged = money(row?.charged);
  const settled = money(paid?.settled);
  return { charged, settled, outstanding: Math.max(0, Math.round((charged - settled) * 100) / 100) };
}

/**
 * The bills this payer still owes something on, oldest first - what a settlement is laid over
 * (`allocateSettlement` in @rch/domain) and what a statement lists.
 *
 * `owed` is the bill's own total less whatever live settlements already closed off it, so a bill
 * a part payment reached comes back as the part that is left. A bill nothing is left on is not
 * here at all: the `having` is what keeps a fully settled bill out of the next allocation.
 */
export async function openBillsFor(
  db: Db | Tx, kind: PayerKind, payerId: string,
): Promise<{ no: string; loc: string; at: Date; total: number; settled: number; owed: number }[]> {
  const rows = await db.select({
    no: s.bills.no, loc: s.bills.loc, at: s.bills.at, total: s.bills.total,
    // Only the lines of settlements nobody voided. A left join with the filter in the `on`
    // clause rather than the `where`, so a bill with no settlement at all still comes back.
    settled: sql<string>`coalesce(sum(${s.settlementLines.amount}), 0)`,
  }).from(s.bills)
    .leftJoin(s.settlementLines, eq(s.settlementLines.billNo, s.bills.no))
    .leftJoin(s.settlements, and(eq(s.settlements.id, s.settlementLines.settlementId), isNull(s.settlements.voidedAt)))
    .where(and(
      inArray(s.bills.tender, [...ACCOUNT_TENDERS]),
      eq(s.bills.payerKind, kind), eq(s.bills.payerId, payerId), isNull(s.bills.voidedAt),
    ))
    .groupBy(s.bills.no, s.bills.loc, s.bills.at, s.bills.total)
    .orderBy(s.bills.at, s.bills.no);

  return rows
    .map((r) => {
      const settled = money(r.settled);
      return { no: r.no, loc: r.loc, at: r.at, total: r.total, settled, owed: Math.round((r.total - settled) * 100) / 100 };
    })
    .filter((r) => r.owed > 0);
}

/** A settlement's own allocation, for the statement and for the void that has to undo it. */
export async function settlementLinesOf(db: Db | Tx, settlementId: string): Promise<{ no: string; amount: number }[]> {
  const rows = await db.select({ no: s.settlementLines.billNo, amount: s.settlementLines.amount })
    .from(s.settlementLines).where(eq(s.settlementLines.settlementId, settlementId))
    .orderBy(s.settlementLines.billNo);
  return rows;
}

/** `sum()` comes back from `pg` as a string, and money is two decimals everywhere it is stored. */
const money = (v: string | null | undefined): number => Math.round(Number(v ?? 0) * 100) / 100;
