import { isNull, sql } from "drizzle-orm";
import type { StockLoc } from "@rch/contract";
import type { Db } from "../../../db/client.js";
import { availabilityOverrides, reservations, stockBalances } from "../../../db/schema/index.js";

/** Every location stock is reported for, quarantine included: a store keeper has to see what a
 *  goods receipt rejected. Nothing is sold, issued or transferred from there — `LocKey`, which
 *  every write body is typed against, still has five members. */
const STOCK_LOCS: StockLoc[] = ["store", "kitchen", "rest", "coffee", "kiosk", "quarantine"];

export async function readStock(db: Db): Promise<Record<StockLoc, Record<string, number>>> {
  const rows = await db.select().from(stockBalances);
  const out = Object.fromEntries(STOCK_LOCS.map((l) => [l, {} as Record<string, number>])) as Record<StockLoc, Record<string, number>>;
  for (const r of rows) if ((STOCK_LOCS as string[]).includes(r.loc)) out[r.loc as StockLoc][r.itemKey] = r.onHand;
  return out;
}
/** "loc:item" -> quantity held by open tickets, the UI's `rsv` map. */
export async function readRsv(db: Db): Promise<Record<string, number>> {
  const rows = await db.select({ loc: reservations.loc, itemKey: reservations.itemKey, qty: sql<string>`round(sum(${reservations.qty}), 3)` })
    .from(reservations).where(isNull(reservations.releasedAt)).groupBy(reservations.loc, reservations.itemKey);
  return Object.fromEntries(rows.map((r) => [`${r.loc}:${r.itemKey}`, Number(r.qty)]));
}
export async function readOvr(db: Db): Promise<Record<string, string>> {
  const rows = await db.select().from(availabilityOverrides);
  return Object.fromEntries(rows.map((r) => [`${r.loc}:${r.itemKey}`, r.reason]));
}
