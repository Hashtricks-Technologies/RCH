// Catalog: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, asc, eq, sql } from "drizzle-orm";
import type { LocKey } from "@rch/contract";
import type { Tx } from "../../lib/db.js";
import { locationItems, priceListItems } from "../../db/schema/index.js";

type PriceList = "A" | "B";

export const catalogRepo = {
  /** `onConflictDoUpdate` on the table's own primary key `(list, item_key)`. */
  upsertPrice: (tx: Tx, list: PriceList, itemKey: string, price: number) =>
    tx.insert(priceListItems).values({ list, itemKey, price, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [priceListItems.list, priceListItems.itemKey], set: { price, updatedAt: new Date() } }),

  isListed: async (tx: Tx, loc: LocKey, itemKey: string): Promise<boolean> =>
    (await tx.select({ itemKey: locationItems.itemKey }).from(locationItems).where(and(eq(locationItems.loc, loc), eq(locationItems.itemKey, itemKey)))).length > 0,

  /** `coalesce(max(seq), 0) + 1` in service.ts keeps the new row after every existing one for this loc. */
  maxSeq: async (tx: Tx, loc: LocKey): Promise<number> => {
    const [row] = await tx.select({ maxSeq: sql<number>`coalesce(max(${locationItems.seq}), 0)` }).from(locationItems).where(eq(locationItems.loc, loc));
    return row?.maxSeq ?? 0;
  },

  insertMenuItem: (tx: Tx, loc: LocKey, itemKey: string, seq: number) => tx.insert(locationItems).values({ loc, itemKey, seq }),

  deleteMenuItem: (tx: Tx, loc: LocKey, itemKey: string) => tx.delete(locationItems).where(and(eq(locationItems.loc, loc), eq(locationItems.itemKey, itemKey))),

  menuItems: async (tx: Tx, loc: LocKey): Promise<string[]> =>
    (await tx.select({ itemKey: locationItems.itemKey }).from(locationItems).where(eq(locationItems.loc, loc)).orderBy(asc(locationItems.seq))).map((r) => r.itemKey),
};
