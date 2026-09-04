// Catalog: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq, like, sql } from "drizzle-orm";
import type { LocKey } from "@rch/contract";
import type { Tx } from "../../lib/db.js";
import { items, locationItems, priceListItems } from "../../db/schema/index.js";

type PriceList = "A" | "B";
export type ItemRow = typeof items.$inferSelect;
export type NewItemRow = typeof items.$inferInsert;

export const catalogRepo = {
  /** Serialise the suffix scan for one slug, so two different names that slug alike cannot both
   *  compute the same key. Transaction-scoped: it is released with the commit or the rollback. */
  async lockSlug(tx: Tx, slug: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"item:" + slug}))`);
  },

  /** Every existing key equal to the slug or the slug plus digits. A plain `like` also catches
   *  an unrelated key that happens to start with the slug — harmless, since the caller only
   *  ever tests membership of the exact candidates it generates (`slug`, `slug2`, `slug3`, …). */
  async keysLike(tx: Tx, slug: string): Promise<Set<string>> {
    const rows = await tx.select({ key: items.key }).from(items).where(like(items.key, `${slug}%`));
    return new Set(rows.map((r) => r.key));
  },

  /** `on conflict do nothing` covers both constraints a new row can hit — the primary key
   *  (which the slug's advisory lock has already made unreachable in practice) and
   *  `items_name_ci_uq`, which is the one this is actually here for: the case-insensitive
   *  name clash reads no row back, and the caller's own sentence is what the loser sees. */
  async insertItem(tx: Tx, row: NewItemRow): Promise<ItemRow | undefined> {
    const [inserted] = await tx.insert(items).values(row).onConflictDoNothing().returning();
    return inserted;
  },

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
