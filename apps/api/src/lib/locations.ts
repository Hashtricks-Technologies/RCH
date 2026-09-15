import { eq } from "drizzle-orm";
import { locations } from "../db/schema/index.js";
import type { Tx } from "./db.js";
import { NotFoundError, RuleError } from "./errors.js";
import type { LocationRow } from "./wire.js";

/**
 * The one way a write names a location: its row, locked `FOR SHARE`.
 *
 * Shared, so every sale at one outlet still runs beside every other, while the admin's close - which
 * takes the same row `FOR UPDATE` (`modules/admin`) - waits for all of them to commit, and a sale
 * that starts after the close has committed reads the outlet closed. The foreign key every document
 * has onto `locations` takes only a key-share lock, which an `UPDATE` of `active` does not wait for,
 * so the explicit lock is what makes the two exclusive.
 *
 * Master data, so the lock belongs to the documents tier: take it before any id and any balance,
 * and the server-wide order - documents, ids, balances - is unchanged.
 */
export async function lockLocation(tx: Tx, key: string): Promise<LocationRow> {
  const [row] = await tx.select().from(locations).where(eq(locations.key, key)).for("share");
  if (!row) throw new NotFoundError(`There is no location ${key}.`);
  return row;
}

/** Nothing new may name a closed outlet. `then` finishes the sentence where there is a way on. */
export function assertOpen(row: Pick<LocationRow, "name" | "active">, then?: string): void {
  if (!row.active) throw new RuleError(`Refused - ${row.name} is closed${then ? `; ${then}` : ""}`);
}
