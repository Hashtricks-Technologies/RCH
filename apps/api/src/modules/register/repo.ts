// Register: SQL only. No rules, no transaction of its own - service.ts opens one (read only for
// an X and for the Z list) and hands every query the same client, so a report is one connection
// out of the pool rather than one per query.
//
// The session row's own locking is not here: `lib/register.ts` owns it, because the counter sale
// takes the same row and a second copy of that lock is a second chance to take it the wrong way
// round. What is here is the raw material the slip is built from - what a session's bills add up
// to, grouped the way a Z prints them - and the one write the module makes, the close itself.
import { and, desc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { RegisterTotals } from "@rch/contract";
import type { Reader, Tx } from "../../lib/db.js";
import { bills, locations, registerSessions, settlements, users } from "../../db/schema/index.js";

/** One tender's takings inside a session: what it collected, what it gave away, and the tax on
 *  it. Four figures from one grouped pass, because the slip needs all four and a second pass
 *  over the same bills is a second answer that can disagree with the first. */
export type SoldLine = { tender: string; amount: number; discount: number; tax: number; bills: number };
/** A session already closed, as the list of past Zs reads it. `closedTotals` is whatever the Z
 *  stored; the service parses it against the wire schema rather than trusting the column. */
export type ClosedRow = { id: string; zNo: string; openedAt: Date; closedAt: Date; closedBy: string | null; closedByName: string | null; closedTotals: unknown };

export const registerRepo = {
  /** The outlet the report is about. Read rather than locked: neither an X nor the list of past
   *  Zs promises anything, and a name is all either needs. The close takes the same row through
   *  `lockLocation`, which is the write's business and not this one's. */
  async location(db: Reader, key: string): Promise<{ name: string } | undefined> {
    const [row] = await db.select({ name: locations.name }).from(locations).where(eq(locations.key, key));
    return row;
  },

  /** Who took the report, as a name: a slip is read by a person and the operator who took it
   *  only ever shows as one. */
  async userName(db: Reader, id: string): Promise<string | undefined> {
    const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, id));
    return row?.name;
  },

  /**
   * What the session sold, per tender.
   *
   * By `session_id`, not by a clock window: the bill was stamped with the session inside the
   * sale's own transaction, so a sale that committed a moment either side of a Z is counted
   * exactly once, by the Z that owns it. A voided bill is not a sale and is left out here; it
   * comes back through `voidedIn` as its own line on the slip.
   */
  async soldIn(db: Reader, sessionId: string): Promise<SoldLine[]> {
    const rows = await db.select({
      tender: bills.tender,
      amount: sql<string>`coalesce(sum(${bills.total}), 0)`,
      discount: sql<string>`coalesce(sum(${bills.discount}), 0)`,
      tax: sql<string>`coalesce(sum(${bills.tax}), 0)`,
      count: sql<number>`count(*)::int`,
    }).from(bills)
      .where(and(eq(bills.sessionId, sessionId), isNull(bills.voidedAt)))
      .groupBy(bills.tender);
    return rows.map((r) => ({ tender: r.tender, amount: money(r.amount), discount: money(r.discount), tax: money(r.tax), bills: r.count }));
  },

  /** What the session took back. A void is only ever possible while the session is open
   *  (`modules/pos` refuses one afterwards), so every void a session will ever carry is already
   *  here by the time the Z counts them. */
  async voidedIn(db: Reader, sessionId: string): Promise<{ amount: number; bills: number }> {
    const [r] = await db.select({
      amount: sql<string>`coalesce(sum(${bills.total}), 0)`,
      count: sql<number>`count(*)::int`,
    }).from(bills).where(and(eq(bills.sessionId, sessionId), isNotNull(bills.voidedAt)));
    return { amount: money(r?.amount), bills: r?.count ?? 0 };
  },

  /**
   * Money taken during the session against bills from an earlier one - the hospital's "Old
   * Bills" lines, by the mode it came in as.
   *
   * A clock window, unlike the sales above, and it has to be: a settlement carries no outlet
   * and no session, because a balance is the hospital's and not one counter's. What that costs
   * is honest and worth naming - a payment taken at the Restaurant desk shows on the Coffee
   * Shop's Z as well, if both were open when it was keyed. It is never added to nett sales
   * either way: this is collection against a debt, not a sale.
   */
  async settledIn(db: Reader, from: Date, to: Date): Promise<{ mode: string; amount: number }[]> {
    const rows = await db.select({ mode: settlements.mode, amount: sql<string>`coalesce(sum(${settlements.amount}), 0)` })
      .from(settlements)
      .where(and(isNull(settlements.voidedAt), gte(settlements.at, from), lt(settlements.at, to)))
      .groupBy(settlements.mode);
    return rows.map((r) => ({ mode: r.mode, amount: money(r.amount) }));
  },

  /** The Z this outlet last took, so a reader can chain Z to Z without arithmetic on clocks. */
  async lastZ(db: Reader, loc: string): Promise<string | null> {
    const [row] = await db.select({ zNo: registerSessions.zNo }).from(registerSessions)
      .where(and(eq(registerSessions.loc, loc), isNotNull(registerSessions.closedAt)))
      .orderBy(desc(registerSessions.closedAt)).limit(1);
    return row?.zNo ?? null;
  },

  /** The Z taken immediately before an instant, which is what the oldest row of a windowed list
   *  chains back to - without it, the first Z on a 7-day list would read as if the hospital had
   *  never closed a register before. */
  async zBefore(db: Reader, loc: string, at: Date): Promise<string | null> {
    const [row] = await db.select({ zNo: registerSessions.zNo }).from(registerSessions)
      .where(and(eq(registerSessions.loc, loc), isNotNull(registerSessions.closedAt), lt(registerSessions.closedAt, at)))
      .orderBy(desc(registerSessions.closedAt)).limit(1);
    return row?.zNo ?? null;
  },

  /** An outlet's past Zs, newest first. The `flatMap` is the narrowing: the WHERE has already
   *  settled that both columns are set, and this is how the type says so without an assertion. */
  async closedSince(db: Reader, loc: string, since: Date): Promise<ClosedRow[]> {
    const rows = await db.select({
      id: registerSessions.id, zNo: registerSessions.zNo,
      openedAt: registerSessions.openedAt, closedAt: registerSessions.closedAt,
      closedBy: registerSessions.closedBy, closedByName: users.name,
      closedTotals: registerSessions.closedTotals,
    }).from(registerSessions)
      .leftJoin(users, eq(users.id, registerSessions.closedBy))
      .where(and(eq(registerSessions.loc, loc), isNotNull(registerSessions.closedAt), gte(registerSessions.closedAt, since)))
      .orderBy(desc(registerSessions.closedAt));
    return rows.flatMap((r) => (r.closedAt && r.zNo ? [{ ...r, closedAt: r.closedAt, zNo: r.zNo }] : []));
  },

  /**
   * Shut the session and stamp the Z on it.
   *
   * `closedTotals` is the Z as printed, stored rather than re-derived: re-deriving it next week
   * against a changed set of bills would answer differently, which is why a settlement's
   * allocation is stored too (`apps/api/CLAUDE.md`).
   *
   * `countedCash` and `note` ride along inside the same column. `RegisterTotalsSchema` has no
   * field for either, so both are stripped back off on the way to the wire and the contract is
   * exactly as written - but what the counter counted is part of the Z they took, and throwing
   * it away at the door would mean a reprinted slip could never show the drawer again. The
   * close's own sentence names the difference, and the audit event keeps the request.
   */
  async close(tx: Tx, id: string, v: { zNo: string; at: Date; by: string; totals: RegisterTotals; countedCash: number | null; note: string }): Promise<void> {
    await tx.update(registerSessions)
      .set({ zNo: v.zNo, closedAt: v.at, closedBy: v.by, closedTotals: { ...v.totals, countedCash: v.countedCash, note: v.note } })
      .where(eq(registerSessions.id, id));
  },
};

/** Every `sum` above comes back as the string `pg` parsed, and money is two decimals. */
const money = (v: string | null | undefined): number => Math.round(Number(v ?? 0) * 100) / 100;
