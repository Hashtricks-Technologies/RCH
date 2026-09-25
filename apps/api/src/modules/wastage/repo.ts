// Wastage: SQL only. No rules, no transaction of its own - the caller passes `tx` (or a read
// transaction's client) in.
import { and, desc, eq, gt, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { KITCHEN } from "@rch/contract";
import type { Reader, Tx } from "../../lib/db.js";
import { items, stockMoves, users, wastage } from "../../db/schema/index.js";

export type WastageRow = typeof wastage.$inferSelect;
export type NewWastage = typeof wastage.$inferInsert;

export const wastageRepo = {
  async insert(tx: Tx, row: NewWastage): Promise<WastageRow> {
    const [r] = await tx.insert(wastage).values(row).returning();
    if (!r) throw new Error(`wastage ${row.id} was not written`);
    return r;
  },

  /** Who signed it, for the record's `by`. */
  async userName(db: Reader, id: string): Promise<string> {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },

  /** The window's records with their signer, newest first. */
  async between(db: Reader, from: Date, to: Date): Promise<(WastageRow & { byName: string | null })[]> {
    const rows = await db.select({ w: wastage, byName: users.name }).from(wastage)
      .leftJoin(users, eq(users.id, wastage.byUser))
      .where(and(gte(wastage.at, from), lt(wastage.at, to)))
      .orderBy(desc(wastage.at), desc(wastage.id));
    return rows.map((r) => ({ ...r.w, byName: r.byName }));
  },

  /**
   * What landed at the kitchen for each raw and packing line over the window - every positive
   * move there that is not the consumption beside it: a ticket received, a count-up, an opening
   * figure. The `production_consume` half is left out on purpose, because the deploy that
   * started this rule cleared what the kitchen was holding with one of those, and that was not
   * an issue. Valued at each item's standard cost.
   */
  async issuedBetween(db: Reader, from: Date, to: Date): Promise<{ it: string; qty: number; cost: number }[]> {
    const rows = await db.select({
      it: stockMoves.itemKey, qty: sql<string>`round(sum(${stockMoves.qty}), 3)`, cost: items.cost,
    }).from(stockMoves).innerJoin(items, eq(items.key, stockMoves.itemKey))
      .where(and(
        eq(stockMoves.loc, KITCHEN), inArray(items.type, ["RAW", "PACK"]), gt(stockMoves.qty, 0),
        ne(stockMoves.kind, "production_consume"), gte(stockMoves.at, from), lt(stockMoves.at, to),
      ))
      .groupBy(stockMoves.itemKey, items.cost)
      .orderBy(stockMoves.itemKey);
    return rows.map((r) => ({ it: r.it, qty: Number(r.qty), cost: r.cost }));
  },
};
