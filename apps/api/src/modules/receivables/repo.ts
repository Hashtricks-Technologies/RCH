// Receivables: SQL only. No rules, no transaction of its own - service.ts passes `tx` in.
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PayerKind } from "@rch/contract";
import { ACCOUNT_TENDERS } from "@rch/domain";
import type { Reader, Tx } from "../../lib/db.js";
import { bills, payerClassTerms, payers, payerTerms, settlementLines, settlements, users } from "../../db/schema/index.js";

export type SettlementRow = typeof settlements.$inferSelect;

export const receivablesRepo = {
  /** The category's own row, locked, so two managers saving the doctors' rate at once queue
   *  rather than race. `head` is the same shape `pricelistsRepo.head` has, for the same reason. */
  async classHead(tx: Tx, cls: string): Promise<{ cls: string; pct: number; limit: number | null } | undefined> {
    const [row] = await tx.select({ cls: payerClassTerms.cls, pct: payerClassTerms.discountPct, limit: payerClassTerms.creditLimit })
      .from(payerClassTerms).where(eq(payerClassTerms.cls, cls)).for("update");
    return row;
  },
  async saveClass(tx: Tx, cls: string, v: { pct: number; limit: number | null; by: string; at: Date }): Promise<void> {
    await tx.insert(payerClassTerms)
      .values({ cls, discountPct: v.pct, creditLimit: v.limit, updatedAt: v.at, updatedBy: v.by })
      .onConflictDoUpdate({
        target: payerClassTerms.cls,
        set: { discountPct: v.pct, creditLimit: v.limit, updatedAt: v.at, updatedBy: v.by },
      });
  },

  /** The payer being given terms of their own, and whether they still bill. An exception on a
   *  switched-off payer is allowed - their balance is still being chased - so `active` comes
   *  back rather than filtering the row out. */
  async payer(tx: Reader, kind: PayerKind, id: string): Promise<{ name: string; active: boolean } | undefined> {
    const [p] = await tx.select({ name: payers.name, active: payers.active })
      .from(payers).where(and(eq(payers.kind, kind), eq(payers.id, id)));
    return p;
  },
  async payerHead(tx: Tx, kind: PayerKind, id: string): Promise<{ pct: number | null; limit: number | null } | undefined> {
    const [row] = await tx.select({ pct: payerTerms.discountPct, limit: payerTerms.creditLimit })
      .from(payerTerms).where(and(eq(payerTerms.kind, kind), eq(payerTerms.payerId, id))).for("update");
    return row;
  },
  async savePayer(tx: Tx, kind: PayerKind, id: string, v: { pct: number | null; limit: number | null; by: string; at: Date }): Promise<void> {
    await tx.insert(payerTerms)
      .values({ kind, payerId: id, discountPct: v.pct, creditLimit: v.limit, updatedAt: v.at, updatedBy: v.by })
      .onConflictDoUpdate({
        target: [payerTerms.kind, payerTerms.payerId],
        set: { discountPct: v.pct, creditLimit: v.limit, updatedAt: v.at, updatedBy: v.by },
      });
  },
  /** An exception that inherits both fields is no exception: the row is removed rather than kept
   *  as two nulls, so the manager's list is the exceptions and nothing else. */
  async dropPayerTerms(tx: Tx, kind: PayerKind, id: string): Promise<void> {
    await tx.delete(payerTerms).where(and(eq(payerTerms.kind, kind), eq(payerTerms.payerId, id)));
  },

  /**
   * Every party who has ever been charged, with what they were charged and what they have paid,
   * in one pass.
   *
   * Two grouped reads rather than one join: joining bills to settlements on the payer multiplies
   * each bill by that payer's settlement count, and a `sum` over the product is wrong by exactly
   * that factor. Summed apart and subtracted in the service, the way `outstandingFor` does it
   * for one person.
   */
  async chargedByPayer(db: Reader): Promise<{ kind: PayerKind; id: string; charged: number; bills: number; oldest: Date }[]> {
    const rows = await db.select({
      kind: bills.payerKind, id: bills.payerId,
      charged: sql<string>`coalesce(sum(${bills.total}), 0)`,
      bills: sql<number>`count(*)::int`,
      oldest: sql<string>`min(${bills.at})`,
    }).from(bills)
      .where(and(inArray(bills.tender, [...ACCOUNT_TENDERS]), isNull(bills.voidedAt)))
      .groupBy(bills.payerKind, bills.payerId);
    // `min(at)` comes back as the string `pg` parsed, like every other aggregate here.
    return rows.flatMap((r) => (r.kind && r.id
      ? [{ kind: r.kind, id: r.id, charged: money(r.charged), bills: r.bills, oldest: new Date(r.oldest) }]
      : []));
  },
  async settledByPayer(db: Reader): Promise<{ kind: PayerKind; id: string; settled: number }[]> {
    const rows = await db.select({
      kind: settlements.kind, id: settlements.payerId,
      settled: sql<string>`coalesce(sum(${settlements.amount}), 0)`,
    }).from(settlements).where(isNull(settlements.voidedAt)).groupBy(settlements.kind, settlements.payerId);
    return rows.map((r) => ({ kind: r.kind, id: r.id, settled: money(r.settled) }));
  },
  /** The register itself, so a party who owes nothing still has a name and a switch to read. */
  async allPayers(db: Reader): Promise<{ kind: PayerKind; id: string; name: string; active: boolean }[]> {
    return db.select({ kind: payers.kind, id: payers.id, name: payers.name, active: payers.active })
      .from(payers).orderBy(asc(payers.name));
  },

  async insertSettlement(tx: Tx, row: typeof settlements.$inferInsert): Promise<SettlementRow> {
    const [s] = await tx.insert(settlements).values(row).returning();
    return s;
  },
  async insertSettlementLines(tx: Tx, id: string, lines: { no: string; amount: number }[]): Promise<void> {
    if (lines.length === 0) return;
    await tx.insert(settlementLines).values(lines.map((l) => ({ settlementId: id, billNo: l.no, amount: l.amount })));
  },
  async headForUpdate(tx: Tx, id: string): Promise<SettlementRow | undefined> {
    const [s] = await tx.select().from(settlements).where(eq(settlements.id, id)).for("update");
    return s;
  },
  async setVoided(tx: Tx, id: string, v: { at: Date; by: string; reason: string }): Promise<SettlementRow> {
    const [s] = await tx.update(settlements)
      .set({ voidedAt: v.at, voidedBy: v.by, voidReason: v.reason })
      .where(eq(settlements.id, id)).returning();
    return s;
  },

  /** One party's payments, newest first - the statement's lower half. The lines come back with
   *  them so the drawer can show which bills each one closed without a read per row. */
  async settlementsOf(db: Reader, kind: PayerKind, id: string): Promise<SettlementRow[]> {
    return db.select().from(settlements)
      .where(and(eq(settlements.kind, kind), eq(settlements.payerId, id)))
      .orderBy(desc(settlements.at), desc(settlements.id));
  },
  async linesOf(db: Reader, ids: string[]): Promise<{ settlementId: string; no: string; amount: number }[]> {
    if (ids.length === 0) return [];
    return db.select({ settlementId: settlementLines.settlementId, no: settlementLines.billNo, amount: settlementLines.amount })
      .from(settlementLines).where(inArray(settlementLines.settlementId, ids))
      .orderBy(asc(settlementLines.billNo));
  },
  /** Everyone's payments, newest first, for the Settlements tab. Bounded rather than whole: a
   *  screen that lists every payment the hospital has ever taken is a screen nobody scrolls. */
  async recentSettlements(db: Reader, limit: number): Promise<SettlementRow[]> {
    return db.select().from(settlements).orderBy(desc(settlements.at), desc(settlements.id)).limit(limit);
  },

  /** Who took a payment, as a name: a settlement is read on a screen and the manager who
   *  recorded it only ever shows as that. */
  async userNames(db: Reader, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  },
};

const money = (v: string | null | undefined): number => Math.round(Number(v ?? 0) * 100) / 100;
