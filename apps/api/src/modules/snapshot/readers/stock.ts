import { isNull, sql } from "drizzle-orm";
import type { LocKey } from "@rch/contract";
import type { Db } from "../../../db/client.js";
import { availabilityOverrides, reservations, stockBalances } from "../../../db/schema/index.js";

const UI_LOCS: LocKey[] = ["store", "kitchen", "rest", "coffee", "kiosk"];

export async function readStock(db: Db): Promise<Record<LocKey, Record<string, number>>> {
  const rows = await db.select().from(stockBalances);
  const out = Object.fromEntries(UI_LOCS.map((l) => [l, {} as Record<string, number>])) as Record<LocKey, Record<string, number>>;
  for (const r of rows) if ((UI_LOCS as string[]).includes(r.loc)) out[r.loc as LocKey][r.itemKey] = r.onHand;
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
