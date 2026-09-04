import { asc } from "drizzle-orm";
import type { Master } from "@rch/domain";
import { items, locations, recipeLines, recipes } from "../db/schema/index.js";
import type { Reader } from "./db.js";
import { toWireItem, toWireLocation } from "./wire.js";

/** Withdrawn items are left out: no rule may price something the master no longer sells. */
export const loadItems = async (db: Reader): Promise<Master["items"]> =>
  Object.fromEntries((await db.select().from(items).orderBy(asc(items.key))).filter((r) => r.active).map((r) => [r.key, toWireItem(r)]));

/** Every location, quarantine included. The rules ignore it; they do not need it hidden,
 *  and since Phase 5 the reader that feeds the UI (readers/master.ts) carries it too — the
 *  store's screens are the ones that read it. */
export const loadLocations = async (db: Reader): Promise<Master["locations"]> =>
  Object.fromEntries((await db.select().from(locations).orderBy(asc(locations.key))).map((r) => [r.key, toWireLocation(r)]));

// The reads below run one after another on purpose: a transaction is a single pg client, and a
// client runs one query at a time — pg queues a concurrent second query today and will refuse
// it in pg 9. Three round trips on master data cost less than a warning in every write's log.
export async function loadRecipes(db: Reader): Promise<Master["recipes"]> {
  const heads = await db.select().from(recipes).orderBy(asc(recipes.itemKey));
  const lines = await db.select().from(recipeLines).orderBy(asc(recipeLines.itemKey), asc(recipeLines.seq));
  return Object.fromEntries(heads.map((h) => [h.itemKey, {
    ov: h.overheadPct, l: lines.filter((l) => l.itemKey === h.itemKey).map((l) => [l.ingredientKey, l.qty] as [string, number]),
  }]));
}

/** Everything `packages/domain` needs to answer a question, read once per request. */
export async function loadMaster(db: Reader): Promise<Master> {
  const items = await loadItems(db);
  const locations = await loadLocations(db);
  const recipes = await loadRecipes(db);
  return { items, locations, recipes };
}
