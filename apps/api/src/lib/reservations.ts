// The one door to `reservations` (spec §5.1, and scripts/check-boundaries.sh keeps it shut):
// approval authorises, the scan moves, and what sits between the two is a row in this table.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { round3, type RsvMap } from "@rch/domain";
import { reservations } from "../db/schema/index.js";
import type { Tx } from "./db.js";

export type ReservationRow = { loc: string; it: string; qty: number; ticketId: string };

/** Hold stock where it stands. Nothing moves: a reservation is what makes free-to-promise
 *  smaller than on-hand, and it lives until the collector's scan releases it. */
export async function reserve(tx: Tx, rows: readonly ReservationRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(reservations).values(rows.map((r) => ({ loc: r.loc, itemKey: r.it, qty: round3(r.qty), ticketId: r.ticketId })));
}

/** Let the stock go, because the moves that replace it are being written in the same
 *  transaction. Returns how many open rows were released, so a caller can tell a first
 *  handover from a replay. */
export async function releaseForTicket(tx: Tx, ticketId: string, at: Date = new Date()): Promise<number> {
  const released = await tx.update(reservations).set({ releasedAt: at })
    .where(and(eq(reservations.ticketId, ticketId), isNull(reservations.releasedAt))).returning({ id: reservations.id });
  return released.length;
}

/** Open reservations at one location, keyed "loc:item" — the shape every domain rule reads. */
export async function reservedAt(tx: Tx, loc: string, itemKeys?: readonly string[]): Promise<RsvMap> {
  // `inArray` with an empty list is not a filter Drizzle can build, and the answer is known
  // anyway: nothing was asked for, so nothing is held.
  if (itemKeys && itemKeys.length === 0) return {};
  const where = itemKeys
    ? and(eq(reservations.loc, loc), isNull(reservations.releasedAt), inArray(reservations.itemKey, [...itemKeys]))
    : and(eq(reservations.loc, loc), isNull(reservations.releasedAt));
  const rows = await tx.select({ itemKey: reservations.itemKey, qty: sql<string>`round(sum(${reservations.qty}), 3)` })
    .from(reservations).where(where).groupBy(reservations.itemKey);
  return Object.fromEntries(rows.map((r) => [`${loc}:${r.itemKey}`, Number(r.qty)]));
}
