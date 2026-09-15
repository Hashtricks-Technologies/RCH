// Price lists: SQL only. No rules, no transaction of its own - service.ts passes `tx` in.
import { asc, eq } from "drizzle-orm";
import { locations, priceListItems, priceLists } from "../../db/schema/index.js";
import type { Tx } from "../../lib/db.js";

export type PriceListRow = typeof priceLists.$inferSelect;
export type OutletRow = { key: string; name: string; type: string; priceListId: string | null };

export const pricelistsRepo = {
  async all(tx: Tx): Promise<PriceListRow[]> {
    return tx.select().from(priceLists).orderBy(asc(priceLists.id));
  },

  /** Locking read on one list's own row, so a concurrent delete of the same id cannot race
   *  another read of it inside this transaction. */
  async head(tx: Tx, id: string): Promise<PriceListRow | undefined> {
    const [row] = await tx.select().from(priceLists).where(eq(priceLists.id, id)).for("update");
    return row;
  },

  /** Every outlet currently active on this list - what a delete has to be clear of. */
  async outletsOf(tx: Tx, id: string): Promise<string[]> {
    const rows = await tx.select({ key: locations.key }).from(locations).where(eq(locations.priceListId, id)).orderBy(asc(locations.key));
    return rows.map((r) => r.key);
  },

  /** The outlet's own row - `createPriceList`'s `cloneFrom` and `setOutletPriceList`'s `loc`
   *  both name a location and both need its type (is it really an outlet?) and its current
   *  list. Not locked: neither caller writes this row through here - `setOutletPriceList`'s own
   *  `UPDATE` takes its lock atomically, and cloning reads a point-in-time list, same as any
   *  other read in this module. */
  async outletRow(tx: Tx, loc: string): Promise<OutletRow | undefined> {
    const [row] = await tx.select({ key: locations.key, name: locations.name, type: locations.type, priceListId: locations.priceListId })
      .from(locations).where(eq(locations.key, loc));
    return row;
  },

  async insert(tx: Tx, row: { id: string; name: string }): Promise<PriceListRow> {
    const [inserted] = await tx.insert(priceLists).values(row).returning();
    if (!inserted) throw new Error(`price list ${row.id} vanished inside its own insert`);
    return inserted;
  },

  async remove(tx: Tx, id: string): Promise<void> {
    await tx.delete(priceLists).where(eq(priceLists.id, id));
  },

  /** Every item/price row on one list, cloned onto another - `createPriceList`'s baseline. */
  async cloneItems(tx: Tx, fromId: string, toId: string): Promise<void> {
    const rows = await tx.select({ itemKey: priceListItems.itemKey, price: priceListItems.price })
      .from(priceListItems).where(eq(priceListItems.listId, fromId));
    if (rows.length > 0) await tx.insert(priceListItems).values(rows.map((r) => ({ listId: toId, itemKey: r.itemKey, price: r.price })));
  },

  async setOutletList(tx: Tx, loc: string, listId: string): Promise<void> {
    await tx.update(locations).set({ priceListId: listId }).where(eq(locations.key, loc));
  },
};
