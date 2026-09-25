import { asc, eq } from "drizzle-orm";
import type { Master } from "@rch/domain";
import { items, locations } from "../db/schema/index.js";
import type { Reader } from "./db.js";
import { toWireItem, toWireLocation } from "./wire.js";

/** Withdrawn items are left out: no rule may price something the master no longer sells. */
export const loadItems = async (db: Reader): Promise<Master["items"]> =>
  Object.fromEntries((await db.select().from(items).orderBy(asc(items.key))).filter((r) => r.active).map((r) => [r.key, toWireItem(r)]));

/** A withdrawn item's name, or `null` for an active or unknown key. `loadItems` leaves a retired
 *  line out, so a rule that must say "retired" rather than "there is no item" asks here. */
export async function retiredItemName(db: Reader, key: string): Promise<string | null> {
  const [row] = await db.select({ name: items.name, active: items.active }).from(items).where(eq(items.key, key));
  return row && !row.active ? row.name : null;
}

/** Every location, quarantine included. The rules ignore it; they do not need it hidden,
 *  and since Phase 5 the reader that feeds the UI (readers/master.ts) carries it too - the
 *  store's screens are the ones that read it. */
export const loadLocations = async (db: Reader): Promise<Master["locations"]> =>
  Object.fromEntries((await db.select().from(locations).orderBy(asc(locations.key))).map((r) => [r.key, toWireLocation(r)]));

/** Everything `packages/domain` needs to answer a question, read once per request.
 *  The reads run one after another on purpose: a transaction is a single pg client, and a
 *  client runs one query at a time - pg queues a concurrent second query today and will refuse
 *  it in pg 9. */
export async function loadMaster(db: Reader): Promise<Master> {
  const items = await loadItems(db);
  const locations = await loadLocations(db);
  return { items, locations };
}
