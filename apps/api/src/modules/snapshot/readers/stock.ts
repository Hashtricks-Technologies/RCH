import { isNull, sql } from "drizzle-orm";
import type { StockLoc } from "@rch/contract";
import { availabilityOverrides, locations, reservations, stockBalances } from "../../../db/schema/index.js";
import type { Reader } from "../../../lib/db.js";

/** One map per location row, quarantine included - a store keeper has to see what a goods receipt
 *  rejected - so a location with nothing on its shelves, an outlet opened this morning, reads as
 *  empty rather than missing. Every balance names a row (a foreign key), so none is dropped. */
export async function readStock(db: Reader): Promise<Record<StockLoc, Record<string, number>>> {
  const locs = await db.select({ key: locations.key }).from(locations);
  const rows = await db.select().from(stockBalances);
  const out: Record<StockLoc, Record<string, number>> = Object.fromEntries(locs.map((l) => [l.key, {}]));
  for (const r of rows) (out[r.loc] ??= {})[r.itemKey] = r.onHand;
  return out;
}
/** "loc:item" -> quantity held by open tickets, the UI's `rsv` map. */
export async function readRsv(db: Reader): Promise<Record<string, number>> {
  const rows = await db.select({ loc: reservations.loc, itemKey: reservations.itemKey, qty: sql<string>`round(sum(${reservations.qty}), 3)` })
    .from(reservations).where(isNull(reservations.releasedAt)).groupBy(reservations.loc, reservations.itemKey);
  return Object.fromEntries(rows.map((r) => [`${r.loc}:${r.itemKey}`, Number(r.qty)]));
}
export async function readOvr(db: Reader): Promise<Record<string, string>> {
  const rows = await db.select().from(availabilityOverrides);
  return Object.fromEntries(rows.map((r) => [`${r.loc}:${r.itemKey}`, r.reason]));
}
