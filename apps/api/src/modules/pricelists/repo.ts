// Price lists: SQL only. No rules, no transaction of its own - service.ts passes `tx` in.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { items, locationItems, locations, priceListItems, priceLists } from "../../db/schema/index.js";
import type { ItemType } from "@rch/contract";
import type { Tx } from "../../lib/db.js";

export type PriceListRow = typeof priceLists.$inferSelect;
export type OutletRow = { key: string; name: string; type: string; priceListId: string | null };
export type LockedOutletRow = typeof locations.$inferSelect;
export type GridItemRow = { key: string; name: string; type: ItemType; active: boolean };

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

  // ---- counter prices ----
  /** The outlet's row locked `FOR UPDATE`: the grid may move it onto a list of its own, and two
   *  saves over one counter must not both decide to fork it. Master data - the documents tier. */
  async lockOutlet(tx: Tx, loc: string): Promise<LockedOutletRow | undefined> {
    const [row] = await tx.select().from(locations).where(eq(locations.key, loc)).for("update");
    return row;
  },

  /** Retired lines included, so the grid can say "retired" rather than "no such item". */
  async itemsByKey(tx: Tx, keys: string[]): Promise<GridItemRow[]> {
    return tx.select({ key: items.key, name: items.name, type: items.type, active: items.active })
      .from(items).where(inArray(items.key, keys));
  },

  async pricesOn(tx: Tx, listId: string): Promise<Map<string, number>> {
    const rows = await tx.select({ itemKey: priceListItems.itemKey, price: priceListItems.price })
      .from(priceListItems).where(eq(priceListItems.listId, listId));
    return new Map(rows.map((r) => [r.itemKey, r.price]));
  },

  async menuOf(tx: Tx, loc: string): Promise<Set<string>> {
    const rows = await tx.select({ itemKey: locationItems.itemKey }).from(locationItems).where(eq(locationItems.loc, loc));
    return new Set(rows.map((r) => r.itemKey));
  },

  upsertPrice: (tx: Tx, listId: string, itemKey: string, price: number) => {
    const now = new Date();
    return tx.insert(priceListItems).values({ listId, itemKey, price, updatedAt: now })
      .onConflictDoUpdate({ target: [priceListItems.listId, priceListItems.itemKey], set: { price, updatedAt: now } });
  },

  /** `seq` computed inside the INSERT, after every existing line - `catalogRepo.insertMenuItem`'s shape. */
  async listOnMenu(tx: Tx, loc: string, itemKey: string): Promise<void> {
    await tx.execute(sql`
      insert into location_items (loc, item_key, seq)
      select ${loc}, ${itemKey}, coalesce(max(seq), 0) + 1 from location_items where loc = ${loc}
      on conflict (loc, item_key) do nothing`);
  },

  async unlistFromMenu(tx: Tx, loc: string, itemKey: string): Promise<void> {
    await tx.delete(locationItems).where(and(eq(locationItems.loc, loc), eq(locationItems.itemKey, itemKey)));
  },
};
