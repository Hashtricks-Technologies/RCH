import { asc } from "drizzle-orm";
import type { UserMin } from "@rch/contract";
import type { Db } from "../../../db/client.js";
import { locationItems, priceListItems, users } from "../../../db/schema/index.js";
import { loadItems, loadLocations, loadRecipes } from "../../../lib/master.js";
import { toWireUserMin } from "../../../lib/wire.js";

/** The item master and the recipes are the same thing the rules read, so they are loaded the same way. */
export const readItems = loadItems;
export const readRecipes = loadRecipes;

/** Every location the hospital has, quarantine included: the store's screens name it, and
 *  `LocationSchema` is keyed by a plain string, so nothing about the wire shape changes. */
export const readLocations = loadLocations;
/** The directory, not a contact list: a colleague's email, employee number and phone are theirs. */
export async function readUsers(db: Db): Promise<UserMin[]> {
  return (await db.select().from(users).orderBy(asc(users.id))).filter((u) => u.active).map(toWireUserMin);
}
export async function readPrices(db: Db): Promise<{ A: Record<string, number>; B: Record<string, number> }> {
  const rows = await db.select().from(priceListItems);
  const out = { A: {} as Record<string, number>, B: {} as Record<string, number> };
  for (const r of rows) out[r.list][r.itemKey] = r.price;
  return out;
}
export async function readMenu(db: Db): Promise<Record<string, string[]>> {
  const rows = await db.select().from(locationItems).orderBy(asc(locationItems.loc), asc(locationItems.seq));
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.loc] ??= []).push(r.itemKey);
  return out;
}
