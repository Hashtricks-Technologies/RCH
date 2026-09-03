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

  /** `onConflictDoNothing().returning()` (the same PK-race shape as lib/ids.ts / lib/ledger.ts):
   *  zero rows back means a concurrent toggle already inserted this row first. Returns whether
   *  this call is the one that inserted it — the caller's result does not depend on it, the row
   *  existing either way is what matters. */
  insert: async (tx: Tx, loc: string, itemKey: string, reason: string, byUser: string): Promise<boolean> =>
    (await tx.insert(availabilityOverrides).values({ loc, itemKey, reason, byUser }).onConflictDoNothing().returning({ loc: availabilityOverrides.loc })).length > 0,

  /** A plain delete with `.returning()`: zero rows back means a concurrent toggle already
   *  removed this row first — still fine, the row is gone either way. */
  remove: async (tx: Tx, loc: string, itemKey: string): Promise<boolean> =>
    (await tx.delete(availabilityOverrides).where(and(eq(availabilityOverrides.loc, loc), eq(availabilityOverrides.itemKey, itemKey))).returning({ loc: availabilityOverrides.loc })).length > 0,
};
