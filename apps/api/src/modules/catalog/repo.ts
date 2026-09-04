// Catalog: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq, sql } from "drizzle-orm";
import type { LocKey } from "@rch/contract";
import type { Tx } from "../../lib/db.js";
import { locationItems, priceListItems } from "../../db/schema/index.js";

type PriceList = "A" | "B";

export const catalogRepo = {
  /** `onConflictDoUpdate` on the table's own primary key `(list, item_key)`. One clock reading
   *  for both branches — inserted or updated, the row records the same moment. */
  upsertPrice: (tx: Tx, list: PriceList, itemKey: string, price: number) => {
    const now = new Date();
    return tx.insert(priceListItems).values({ list, itemKey, price, updatedAt: now })
      .onConflictDoUpdate({ target: [priceListItems.list, priceListItems.itemKey], set: { price, updatedAt: now } });
  },

  isListed: async (tx: Tx, loc: LocKey, itemKey: string): Promise<boolean> =>
    (await tx.select({ itemKey: locationItems.itemKey }).from(locationItems).where(and(eq(locationItems.loc, loc), eq(locationItems.itemKey, itemKey)))).length > 0,

  /**
   * List the item, in one statement. `seq` is `coalesce(max(seq), 0) + 1` computed inside the
   * INSERT — read in an earlier statement it could already be stale by the time this one ran —
   * so the new row lands after every existing one for this location. `on conflict do nothing`
   * makes the second of two concurrent adds return no row at all, which is how service.ts
   * tells the loser it lost instead of raising a primary-key violation at it.
   */
  insertMenuItem: async (tx: Tx, loc: LocKey, itemKey: string): Promise<string[]> => {
    const r = await tx.execute<{ item_key: string }>(sql`
      insert into location_items (loc, item_key, seq)
      select ${loc}, ${itemKey}, coalesce(max(seq), 0) + 1 from location_items where loc = ${loc}
      on conflict (loc, item_key) do nothing
      returning item_key`);
    return r.rows.map((row) => row.item_key);
  },

  deleteMenuItem: (tx: Tx, loc: LocKey, itemKey: string) => tx.delete(locationItems).where(and(eq(locationItems.loc, loc), eq(locationItems.itemKey, itemKey))),

  menuItems: async (tx: Tx, loc: LocKey): Promise<string[]> =>
    (await tx.select({ itemKey: locationItems.itemKey }).from(locationItems).where(eq(locationItems.loc, loc)).orderBy(asc(locationItems.seq))).map((r) => r.itemKey),
};
