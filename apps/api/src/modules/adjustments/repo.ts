// Adjustments: SQL only. No rules, no transaction of its own - the caller passes `tx` in.
//
// This module's own door (`service.ts`'s `create`) is now a thin wrapper around
// apps/api/src/lib/adjustments.ts's `writeAdjustment`, once modules/adjustmentRequests needed
// the same write from its own decision - two callers writing one shelf's document is two things
// to keep in step. The queries below stayed here rather than moving into `lib/` with the rest:
// they are plain reads and inserts with no rule attached, and `writeAdjustment` calls them from
// there the same way it would call any other module's repo, rather than duplicating them.
// Reading the register back is `readAdjustments` in modules/snapshot/readers/documents.ts,
// beside every other document's reader, rather than a second read here.
import { and, eq, inArray } from "drizzle-orm";
import { adjustmentLines, adjustments, stockBalances, users } from "../../db/schema/index.js";
import type { Tx } from "../../lib/db.js";

export type AdjustmentRow = typeof adjustments.$inferSelect;
export type NewAdjustment = typeof adjustments.$inferInsert;
export type NewAdjustmentLine = typeof adjustmentLines.$inferInsert;

export const adjustmentsRepo = {
  /** On hand at one location for the items named - read only after `lockBalances` has taken
   *  those rows, never before: a balance read outside the lock is a promise made from a number
   *  that can change under it. */
  async balancesAt(tx: Tx, loc: string, itemKeys: readonly string[]): Promise<Record<string, number>> {
    if (itemKeys.length === 0) return {};
    const rows = await tx.select().from(stockBalances)
      .where(and(eq(stockBalances.loc, loc), inArray(stockBalances.itemKey, [...itemKeys])));
    return Object.fromEntries(rows.map((r) => [r.itemKey, r.onHand]));
  },

  async insertHead(tx: Tx, row: NewAdjustment): Promise<AdjustmentRow> {
    const [r] = await tx.insert(adjustments).values(row).returning();
    if (!r) throw new Error(`adjustment ${row.id} was not written`);
    return r;
  },

  async insertLines(tx: Tx, rows: NewAdjustmentLine[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(adjustmentLines).values(rows);
  },

  /** Who signed it, for the history row and the document's `by`. */
  async userName(tx: Tx, id: string): Promise<string> {
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },
};
