// Catalog: SQL only. No rules, no transaction of its own - service.ts passes `tx` in.
import { and, asc, eq, like, ne, sql } from "drizzle-orm";
import type { LocKey } from "@rch/contract";
import { isUniqueViolation, type Reader, type Tx } from "../../lib/db.js";
import { items, locationItems, priceListItems, priceLists, stockBalances } from "../../db/schema/index.js";

export type ItemRow = typeof items.$inferSelect;
export type NewItemRow = typeof items.$inferInsert;
// ---- item patch ----
/** `mrp` is a `number`, never `null`: an item that carries a printed MRP keeps one, so there is
 *  no value this patch can take that removes a ceiling. The column stays nullable - an item may
 *  never have had one - but no write on this side sets it back to nothing. `shelfLifeHours` is
 *  the opposite: clearing it back to "no best-before" is exactly what a blank box has always
 *  meant on the create-item form, so this side does allow `null`. */
export type ItemPatch = Partial<{
  name: string; displayName: string | null; grp: string; hsn: string; gst: number;
  reorderLevel: number; cost: number; mrp: number; shelfLifeHours: number | null; active: boolean;
  src: "store" | "kitchen";
}>;

export const catalogRepo = {
  /** Serialise the suffix scan for one slug, so two different names that slug alike cannot both
   *  compute the same key. Transaction-scoped: it is released with the commit or the rollback. */
  async lockSlug(tx: Tx, slug: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"item:" + slug}))`);
  },

  /** Every existing key equal to the slug or the slug plus digits. A plain `like` also catches
   *  an unrelated key that happens to start with the slug - harmless, since the caller only
   *  ever tests membership of the exact candidates it generates (`slug`, `slug2`, `slug3`, …). */
  async keysLike(tx: Tx, slug: string): Promise<Set<string>> {
    const rows = await tx.select({ key: items.key }).from(items).where(like(items.key, `${slug}%`));
    return new Set(rows.map((r) => r.key));
  },

  /** Serialise the code series of one item type, so two new products of the same type cannot
   *  both read the same highest code and both take the next one. `items.code` carries no unique
   *  index, so this lock is the whole guarantee. */
  async lockCodeSeries(tx: Tx, prefix: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"item-code:" + prefix}))`);
  },

  /** Every code in one series (`RM-…`), retired lines included - a retired code is never reissued. */
  async codesLike(tx: Tx, prefix: string): Promise<string[]> {
    const rows = await tx.select({ code: items.code }).from(items).where(like(items.code, `${prefix}-%`));
    return rows.map((r) => r.code);
  },

  /** `on conflict do nothing` covers both constraints a new row can hit - the primary key
   *  (which the slug's advisory lock has already made unreachable in practice) and
   *  `items_name_ci_uq`, which is the one this is actually here for: the case-insensitive
   *  name clash reads no row back, and the caller's own sentence is what the loser sees. */
  async insertItem(tx: Tx, row: NewItemRow): Promise<ItemRow | undefined> {
    const [inserted] = await tx.insert(items).values(row).onConflictDoNothing().returning();
    return inserted;
  },

  /** Whether a price list id names a real list - checked before `upsertPrice`, so an unknown id
   *  reaches the manager as "There is no price list …" rather than a raw foreign-key 500. */
  async priceListExists(tx: Tx, id: string): Promise<boolean> {
    const [row] = await tx.select({ id: priceLists.id }).from(priceLists).where(eq(priceLists.id, id));
    return row !== undefined;
  },

  /** `onConflictDoUpdate` on the table's own primary key `(list_id, item_key)`. One clock reading
   *  for both branches - inserted or updated, the row records the same moment. */
  upsertPrice: (tx: Tx, listId: string, itemKey: string, price: number) => {
    const now = new Date();
    return tx.insert(priceListItems).values({ listId, itemKey, price, updatedAt: now })
      .onConflictDoUpdate({ target: [priceListItems.listId, priceListItems.itemKey], set: { price, updatedAt: now } });
  },

  isListed: async (tx: Tx, loc: LocKey, itemKey: string): Promise<boolean> =>
    (await tx.select({ itemKey: locationItems.itemKey }).from(locationItems).where(and(eq(locationItems.loc, loc), eq(locationItems.itemKey, itemKey)))).length > 0,

  /**
   * List the item, in one statement. `seq` is `coalesce(max(seq), 0) + 1` computed inside the
   * INSERT - read in an earlier statement it could already be stale by the time this one ran -
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

  // ---- item patch ----
  /**
   * Locking read on one item's own row, so two patches of the same line cannot both read the
   * row that is about to change under them.
   *
   * **It deliberately does not filter `active`.** `loadItems` does - no rule may price something
   * the master no longer sells - but a retired line has to stay reachable through this door or
   * it could never be brought back, and "restore" would be the one edit retiring an item made
   * impossible.
   */
  async head(tx: Tx, key: string): Promise<ItemRow | undefined> {
    const [row] = await tx.select().from(items).where(eq(items.key, key)).for("update");
    return row;
  },

  /** Whether another line already holds this name, case-insensitively. The pre-check that gives
   *  the operator their sentence; `items_name_ci_uq` on the UPDATE is what actually arbitrates. */
  async nameTaken(tx: Tx, name: string, exceptKey: string): Promise<boolean> {
    const rows = await tx.select({ key: items.key }).from(items)
      .where(and(sql`lower(${items.name}) = lower(${name})`, ne(items.key, exceptKey)));
    return rows.length > 0;
  },

  /** Every price list this item sits on. The MRP floor is checked against the highest of them:
   *  a ceiling that clears one list but not another is still one counter that cannot sell. */
  async pricesOf(tx: Tx, key: string): Promise<{ list: string; price: number }[]> {
    return tx.select({ list: priceListItems.listId, price: priceListItems.price })
      .from(priceListItems).where(eq(priceListItems.itemKey, key));
  },

  /** The outlets still listing this item on their till - what a retirement has to be clear of. */
  async menusOf(tx: Tx, key: string): Promise<string[]> {
    const rows = await tx.select({ loc: locationItems.loc }).from(locationItems)
      .where(eq(locationItems.itemKey, key)).orderBy(asc(locationItems.loc));
    return rows.map((r) => r.loc);
  },

  /** The locations still carrying stock of it. A row at zero is "carried, empty" (M12) and is
   *  not a reason to refuse a retirement - only a non-zero balance is stock to write off. */
  async balancesOf(tx: Tx, key: string): Promise<string[]> {
    const rows = await tx.select({ loc: stockBalances.loc }).from(stockBalances)
      .where(and(eq(stockBalances.itemKey, key), ne(stockBalances.onHand, 0)))
      .orderBy(asc(stockBalances.loc));
    return rows.map((r) => r.loc);
  },

  /** `undefined` means what it means for `insertItem`: the row this would have produced already
   *  exists under another key. A rename into a name another item holds hits `items_name_ci_uq`
   *  on the UPDATE itself, caught here rather than surfacing as a raw 500 - the caller reads the
   *  same "already in the catalogue" sentence the insert's arbiter gives a new product
   *  (`vendorsRepo.update`'s shape). Renaming an item to a case-only variant of its own current
   *  name is not a violation - the index only ever sees one row with that value - and succeeds. */
  async update(tx: Tx, key: string, patch: ItemPatch): Promise<ItemRow | undefined> {
    try {
      const [row] = await tx.update(items).set({ ...patch, updatedAt: new Date() }).where(eq(items.key, key)).returning();
      if (!row) throw new Error(`item ${key} vanished inside its own transaction`);
      return row;
    } catch (err) {
      if (isUniqueViolation(err, "items_name_ci_uq")) return undefined;
      throw err;
    }
  },

  // ---- item photos ----
  /** What the photo rules read before any byte is stored: the item and whether this outlet lists
   *  it. A plain read, not a lock - the write asks the same questions again under `head`. */
  async photoTarget(r: Reader, key: string, loc: LocKey): Promise<{ name: string; active: boolean; listed: boolean } | undefined> {
    const [row] = await r.select({ name: items.name, active: items.active }).from(items).where(eq(items.key, key));
    if (!row) return undefined;
    const listed = await r.select({ k: locationItems.itemKey }).from(locationItems)
      .where(and(eq(locationItems.loc, loc), eq(locationItems.itemKey, key)));
    return { ...row, listed: listed.length > 0 };
  },

  /** The hash the item's photo is stored under: `undefined` for no such item, `null` for none. */
  async imageOf(r: Reader, key: string): Promise<string | null | undefined> {
    const [row] = await r.select({ image: items.image }).from(items).where(eq(items.key, key));
    return row ? row.image : undefined;
  },

  async setImage(tx: Tx, key: string, image: string | null): Promise<ItemRow> {
    const [row] = await tx.update(items).set({ image, updatedAt: new Date() }).where(eq(items.key, key)).returning();
    if (!row) throw new Error(`item ${key} vanished inside its own transaction`);
    return row;
  },
};
