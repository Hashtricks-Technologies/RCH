// Availability: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { and, eq } from "drizzle-orm";
import type { Tx } from "../../lib/db.js";
import { availabilityOverrides, locationItems } from "../../db/schema/index.js";

export const availabilityRepo = {
  /** Whether `it` is on `loc`'s menu (the `location_items` table) at all. */
  isListed: async (tx: Tx, loc: string, itemKey: string): Promise<boolean> =>
    (await tx.select().from(locationItems).where(and(eq(locationItems.loc, loc), eq(locationItems.itemKey, itemKey)))).length > 0,

  find: async (tx: Tx, loc: string, itemKey: string) =>
    (await tx.select().from(availabilityOverrides).where(and(eq(availabilityOverrides.loc, loc), eq(availabilityOverrides.itemKey, itemKey))))[0],

  insert: (tx: Tx, loc: string, itemKey: string, reason: string, byUser: string) =>
    tx.insert(availabilityOverrides).values({ loc, itemKey, reason, byUser }),

  remove: (tx: Tx, loc: string, itemKey: string) =>
    tx.delete(availabilityOverrides).where(and(eq(availabilityOverrides.loc, loc), eq(availabilityOverrides.itemKey, itemKey))),
};
