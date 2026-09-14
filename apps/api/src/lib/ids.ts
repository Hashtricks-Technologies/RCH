import { sql } from "drizzle-orm";
import { formatId, SEQUENCE_START, type IdKind } from "@rch/domain";
import { sequences } from "../db/schema/index.js";
import type { Tx } from "./db.js";
import { recordAllocation } from "./metrics-db.js";

/** Insert any series that is missing, starting where the seeded documents leave off. */
export async function ensureSequences(tx: Tx): Promise<void> {
  const rows = (Object.keys(SEQUENCE_START) as IdKind[]).map((kind) => ({ kind, next: SEQUENCE_START[kind] }));
  await tx.insert(sequences).values(rows).onConflictDoNothing();
}

/**
 * Serialised, and gapless through a rollback: the counter is a row, the lock UPDATE takes on it
 * holds until the caller's transaction ends, and a refusal undoes the increment with everything
 * else - so the next writer is handed the number the refused one was standing on. That is the
 * whole of what the lock buys, and it is not free: **every other writer in the series waits on
 * that row for as long as the allocating transaction runs**, so a write that can still be
 * refused, or that can still block on something else, takes its number as late as it can.
 * `modules/pos/service.ts` is the worked example. `recordAllocation` counts attempts rather than
 * documents, so a rolled-back sale still shows up on `sequence_allocations_total`.
 *
 * Returns the raw number alongside the formatted id, for a caller that needs the counter itself
 * rather than the string it prints.
 */
export async function allocateNumber(tx: Tx, kind: IdKind, at: Date = new Date()): Promise<{ n: number; id: string }> {
  const r = await tx.execute(sql`update sequences set next = next + 1 where kind = ${kind} returning next - 1 as n`);
  const row = r.rows[0] as { n: number | string } | undefined;
  if (!row) throw new Error(`sequence "${kind}" is not initialised - run ensureSequences()`);
  recordAllocation(kind);
  const n = Number(row.n);
  return { n, id: formatId(kind, n, at) };
}

export const allocateId = async (tx: Tx, kind: IdKind, at: Date = new Date()): Promise<string> =>
  (await allocateNumber(tx, kind, at)).id;
