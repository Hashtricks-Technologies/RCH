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

/** Gapless and serialised: the row lock taken by UPDATE holds until the caller's transaction
 *  ends. Returns the raw number alongside the formatted id, for a caller that needs the counter
 *  itself rather than the string it prints. */
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
