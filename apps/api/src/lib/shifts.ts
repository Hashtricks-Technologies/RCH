import { and, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { LocKey, ShiftTotals, TenderLine } from "@rch/contract";
import { ShiftTotalsSchema, TenderSchema } from "@rch/contract";
import { ACCOUNT_TENDERS } from "@rch/domain";
import { bills, shifts } from "../db/schema/index.js";
import type { Reader, Tx } from "./db.js";
import { emitChanged } from "./events.js";
import { allocateId } from "./ids.js";

/**
 * A counter operator's shift: the row, its figures, and the three ways it moves.
 *
 * Two modules need it for opposite reasons - `modules/auth` opens one at sign-in and closes the
 * one left open at another counter, `modules/shifts` reads it live and closes it when the
 * operator presses Close Shift - so it lives here, beside `lib/register.ts`, rather than in
 * either module's repo.
 *
 * **The window is a clock, not a foreign key.** A bill carries its register session, but not a
 * shift: a shift's report is that operator's own bills at that counter from `opened_at` to the
 * close. A sale the same operator commits in the instant their close is counting can fall either
 * side of it; they are closing their own shift and signing out, so there is nobody else's sale
 * to race with.
 *
 * **Every write takes `lockShiftsOf` first**, an advisory lock on the person, in the documents
 * tier - before any id. Two sign-ins racing each other (two tabs, two devices) would otherwise
 * both read "nothing open" and the second insert would die on `shifts_one_open_per_user` as a
 * bare 500 at the sign-in screen.
 */
export type ShiftRow = typeof shifts.$inferSelect;

const money = (n: number): number => Math.round(n * 100) / 100;
const num = (v: string | null | undefined): number => money(Number(v ?? 0));
const isCredit = (tender: string): boolean => (ACCOUNT_TENDERS as readonly string[]).includes(tender);

export async function lockShiftsOf(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`shift:${userId}`}))`);
}

/** The person's open shift, wherever it is. There is at most one (`shifts_one_open_per_user`). */
export async function openShiftOf(db: Reader, userId: string): Promise<ShiftRow | undefined> {
  const [row] = await db.select().from(shifts).where(and(eq(shifts.userId, userId), isNull(shifts.closedAt)));
  return row;
}

/**
 * What one operator billed at one counter between two instants: per tender (every tender the
 * till has, in the schema's order, whether or not it took anything - "Card 0.00" is a line the
 * hand-over reads), the discount and tax on it, and what was voided. A voided bill is not a
 * sale; it comes back on its own line.
 */
export async function shiftTotals(db: Reader, userId: string, loc: string, from: Date, to: Date): Promise<ShiftTotals> {
  const mine = and(eq(bills.operatorId, userId), eq(bills.loc, loc), gte(bills.at, from), lte(bills.at, to));
  const sold = await db.select({
    tender: bills.tender,
    amount: sql<string>`coalesce(sum(${bills.total}), 0)`,
    discount: sql<string>`coalesce(sum(${bills.discount}), 0)`,
    tax: sql<string>`coalesce(sum(${bills.tax}), 0)`,
    count: sql<number>`count(*)::int`,
  }).from(bills).where(and(mine, isNull(bills.voidedAt))).groupBy(bills.tender);
  const [voided] = await db.select({
    amount: sql<string>`coalesce(sum(${bills.total}), 0)`,
    count: sql<number>`count(*)::int`,
  }).from(bills).where(and(mine, isNotNull(bills.voidedAt)));

  const byTender = new Map(sold.map((r) => [r.tender, r]));
  // A tender the data carries and the schema no longer names is appended rather than dropped:
  // a total no line accounts for is the one thing a hand-over must never print.
  const tenders: TenderLine[] = [...new Set<string>([...TenderSchema.options, ...byTender.keys()])]
    .map((tender) => ({ tender, amount: num(byTender.get(tender)?.amount), bills: byTender.get(tender)?.count ?? 0 }));
  const collected = money(tenders.filter((t) => !isCredit(t.tender)).reduce((a, t) => a + t.amount, 0));
  const creditSales = money(tenders.filter((t) => isCredit(t.tender)).reduce((a, t) => a + t.amount, 0));
  const nettSales = money(collected + creditSales);
  const discount = money(sold.reduce((a, r) => a + num(r.discount), 0));
  return {
    billCount: sold.reduce((a, r) => a + r.count, 0),
    grossSales: money(nettSales + discount), discount, nettSales,
    taxTotal: money(sold.reduce((a, r) => a + num(r.tax), 0)),
    tenders, collected, creditSales,
    voidAmount: num(voided?.amount), voidBills: voided?.count ?? 0,
  };
}

/** A closed shift's stored figures, as the wire carries them. `auto` rides in the same column. */
export function storedTotals(row: ShiftRow): { totals: ShiftTotals; auto: boolean } {
  const raw = (row.closedTotals ?? {}) as { auto?: unknown };
  return { totals: ShiftTotalsSchema.parse(raw), auto: raw.auto === true };
}

/**
 * Close a shift the caller has already locked and read, storing what it billed.
 *
 * The figures are stored rather than re-derived, for the reason a Z's are: a manager reading the
 * hand-over next week must read what the operator was handed, not a sum over bills a manager
 * has voided since.
 */
export async function closeShiftRow(tx: Tx, row: ShiftRow, at: Date, auto: boolean): Promise<ShiftTotals> {
  const totals = await shiftTotals(tx, row.userId, row.loc, row.openedAt, at);
  await tx.update(shifts).set({ closedAt: at, closedTotals: { ...totals, auto } }).where(eq(shifts.id, row.id));
  return totals;
}

/**
 * The sign-in's half: make sure the person has a shift open at the counter this session stands
 * at. Signing in again at the same counter - a second tab, a reload, the next morning without a
 * close - keeps the shift that is open. One left open at a **different** counter is closed
 * automatically, its figures stored and marked `auto`, and a new one opens here.
 *
 * Only an auto-close changes anything the manager reads, so only that announces `shifts`.
 */
export async function startShift(tx: Tx, userId: string, loc: LocKey): Promise<void> {
  await lockShiftsOf(tx, userId);
  const held = await openShiftOf(tx, userId);
  if (held?.loc === loc) return;
  const at = new Date();
  if (held) await closeShiftRow(tx, held, at, true);
  const id = await allocateId(tx, "shift", at);
  await tx.insert(shifts).values({ id, userId, loc, openedAt: at });
  if (held) await emitChanged(tx, ["shifts"]);
}
