// Production: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { LocKey, PordStatus, ProdOrder } from "@rch/contract";
import { availabilityOverrides, batches, locationItems, prodOrderLines, prodOrders, stockBalances, users } from "../../db/schema/index.js";
import type { Tx } from "../../lib/db.js";
import { readHistory } from "../../lib/history.js";
import { iso } from "../../lib/time.js";

export type ProdOrderHead = typeof prodOrders.$inferSelect;

export const productionRepo = {
  /**
   * A locking read. Every status transition reads its own row `for update` (spec §5.1): two
   * screens pressing Dispatch together would otherwise both see the order open, both pass the
   * guard and both raise a ticket for stock that is only there once. The lock is held to the
   * end of the transaction, so the second caller reads what the first committed and is refused.
   */
  async head(tx: Tx, id: string): Promise<ProdOrderHead | undefined> {
    const [o] = await tx.select().from(prodOrders).where(eq(prodOrders.id, id)).for("update");
    return o;
  },

  /** The order as it was written, in the kitchen's own line order. */
  async lines(tx: Tx, id: string): Promise<{ it: string; qty: number }[]> {
    const rows = await tx.select().from(prodOrderLines).where(eq(prodOrderLines.orderId, id)).orderBy(asc(prodOrderLines.lineNo));
    return rows.map((l) => ({ it: l.itemKey, qty: l.qty }));
  },

  async setStatus(tx: Tx, id: string, status: PordStatus): Promise<void> {
    await tx.update(prodOrders).set({ status, updatedAt: new Date() }).where(eq(prodOrders.id, id));
  },

  /** On hand at one location, for the items a write is about — read after `lockBalances`,
   *  because a promise made against an unlocked balance is a promise two writers can make. */
  async balancesAt(tx: Tx, loc: string, itemKeys: readonly string[]): Promise<Record<string, number>> {
    if (itemKeys.length === 0) return {};
    const rows = await tx.select().from(stockBalances)
      .where(and(eq(stockBalances.loc, loc), inArray(stockBalances.itemKey, [...itemKeys])))
      .orderBy(asc(stockBalances.itemKey));
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.onHand]));
  },

  /** What the destination is allowed to sell, as a membership test (M9). */
  async menuAt(tx: Tx, loc: string): Promise<Set<string>> {
    const rows = await tx.select({ itemKey: locationItems.itemKey }).from(locationItems).where(eq(locationItems.loc, loc));
    return new Set(rows.map((r) => r.itemKey));
  },

  /** Whether the kitchen has switched this product off, and the reason it recorded.
   *  Read inside the write's transaction, so a switch flipped a moment ago is seen. */
  async overrideAt(tx: Tx, loc: string, itemKey: string): Promise<string | undefined> {
    const [o] = await tx.select({ reason: availabilityOverrides.reason }).from(availabilityOverrides)
      .where(and(eq(availabilityOverrides.loc, loc), eq(availabilityOverrides.itemKey, itemKey)));
    return o?.reason;
  },

  /** The batch document. `.returning()` hands back what the database stored — the defaulted
   *  `at` included — so the wire shape and the ledger's timestamps cannot drift apart. */
  async insertBatch(tx: Tx, v: typeof batches.$inferInsert): Promise<typeof batches.$inferSelect> {
    const [row] = await tx.insert(batches).values(v).returning();
    return row!;
  },

  /** Who signed it, for the history row the board prints. */
  async userName(tx: Tx, id: string): Promise<string> {
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },

  /** The wire shape `readProdOrders` produces, for the one order a write has just changed. */
  async wire(tx: Tx, id: string): Promise<ProdOrder> {
    const [head] = await tx.select().from(prodOrders).where(eq(prodOrders.id, id));
    if (!head) throw new Error(`prod order ${id} vanished mid-transaction`);
    const lines = await productionRepo.lines(tx, id);
    const by = await productionRepo.userName(tx, head.byUser);
    const hist = await readHistory(tx, "prod_order", id);
    return { id: head.id, from: head.fromLoc as LocKey, by, at: iso(head.at), lines, st: head.status, note: head.note, hist };
  },
};
