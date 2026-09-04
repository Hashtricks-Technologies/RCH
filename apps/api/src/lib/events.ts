import { sql } from "drizzle-orm";
import type { Changed } from "@rch/contract";
import type { Tx } from "./db.js";

/**
 * LISTEN channels belong to the database, not to a schema — and every test file runs in its
 * own schema inside one database. The channel therefore carries the schema, computed in SQL on
 * this side and from `select current_schema()` on the listening side, so neither end needs the
 * name plumbed through.
 */
export const EVENTS_CHANNEL_PREFIX = "rch_events_";

export type ChangeNotice = { collections: Changed[]; at: string };

/**
 * Publish what a write changed. `pg_notify` inside a transaction is held by Postgres until
 * that transaction commits, which is exactly the spec's "whenever a write commits touching
 * that collection" (§6): a refusal that rolls the write back announces nothing.
 *
 * Call it last in the service, with the same array the response's `changed` carries.
 */
export async function emitChanged(tx: Tx, changed: readonly Changed[]): Promise<void> {
  const collections = [...new Set(changed)];
  if (collections.length === 0) return;
  const payload = JSON.stringify({ collections, at: new Date().toISOString() } satisfies ChangeNotice);
  await tx.execute(sql`select pg_notify(${EVENTS_CHANNEL_PREFIX} || current_schema(), ${payload})`);
}
