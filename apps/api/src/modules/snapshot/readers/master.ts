import { asc } from "drizzle-orm";
import type { Item, Location, Recipe, User } from "@rch/contract";
import type { Db } from "../../../db/client.js";
import { items, locationItems, locations, priceListItems, recipeLines, recipes, users } from "../../../db/schema/index.js";
import { toWireUser } from "../../../lib/wire.js";

const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export async function readItems(db: Db): Promise<Record<string, Item>> {
  const rows = await db.select().from(items).orderBy(asc(items.key));
  return Object.fromEntries(rows.filter((r) => r.active).map((r) => [r.key, strip({
    c: r.code, n: r.name, u: r.unit, t: r.type, g: r.grp, hsn: r.hsn, gst: r.gst, rl: r.reorderLevel, cost: r.cost,
    mrp: r.mrp ?? undefined, sl: r.shelfLifeHours ?? undefined,
  })]));
}
/** The five UI locations only; quarantine joins the contract in Phase 5. */
export async function readLocations(db: Db): Promise<Record<string, Location>> {
  const rows = await db.select().from(locations);
  return Object.fromEntries(rows.filter((r) => r.key !== "quarantine").map((r) => [r.key, strip({
    n: r.name, c: r.code, type: r.type, floor: r.floor, cc: r.costCentre, list: r.priceList ?? undefined,
  })]));
}
export async function readRecipes(db: Db): Promise<Record<string, Recipe>> {
  const heads = await db.select().from(recipes);
  const lines = await db.select().from(recipeLines).orderBy(asc(recipeLines.itemKey), asc(recipeLines.seq));
  return Object.fromEntries(heads.map((h) => [h.itemKey, { ov: h.overheadPct, l: lines.filter((l) => l.itemKey === h.itemKey).map((l) => [l.ingredientKey, l.qty] as [string, number]) }]));
}
export async function readUsers(db: Db): Promise<User[]> {
  return (await db.select().from(users).orderBy(asc(users.id))).filter((u) => u.active).map(toWireUser);
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
