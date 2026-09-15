import { and, eq, isNull, sql } from "drizzle-orm";
import { idempotencyKeys } from "../db/schema/index.js";
import type { IdemContext } from "../plugins/idempotency.js";
import type { Tx } from "./db.js";

/** How long a recorded outcome stays replayable. Defined here rather than in the plugin because
 *  both the record inside the transaction and `onSend`'s fallback push the same window out. */
export const TTL_MS = 24 * 3600_000;
/** `response` is `jsonb not null`, so an empty body has to be stored as the JSON literal `null` -
 *  handing drizzle a JS `null` would write an SQL NULL and break the constraint. */
export const JSON_NULL = sql`'null'::jsonb`;

/** What `mount()` says when a write's answer never reached its claim row and no more specific
 *  cause is known - the write ran no transaction at all. The cause-specific sentences are built
 *  by `recordIdempotent` below. */
export const NOT_RECORDED = "a write's response was not recorded inside its own transaction";

/** `{ ok: true }` with the response as its schema parsed it (what was stored, and what the audit
 *  event carries), or why the response is not in the claim row - a sentence a log line or a
 *  thrown error can carry as it stands. */
export type RecordOutcome = { ok: true; body: unknown } | { ok: false; why: string };

/**
 * Write the response into the claim row **from inside the write's own transaction**, as the
 * last statement before COMMIT.
 *
 * That placement is the whole point: the row is committed by the same COMMIT that commits the
 * bill, so there is no instant at which the write has happened and the key does not know it.
 * Everything that used to stand between the two - the pod staying alive, the pool handing out a
 * second connection, the response surviving its own serializer - is out of the picture.
 *
 * The value is validated against the route's response schema first, and what is stored is the
 * *parsed* value, so a replay serialises byte-for-byte what the first attempt sent. A value the
 * schema refuses is not stored and the first issue comes back in `why`: either this transaction
 * was not the one that produced the response (a write may open more than one), or the response
 * is genuinely malformed. `withTransaction` decides which of those it is.
 *
 * The UPDATE is guarded `committed_at is null` for the takeover race. A request slow enough to
 * be declared abandoned (`CLAIM_STALE_MS`) has its claim taken over and the write re-run; if the
 * original then finishes, it must not overwrite the winner's committed answer with its own. Zero
 * rows updated says exactly that happened, and `false` comes back - which in development and test
 * rolls the straggler's own write back, where it belongs.
 */
export async function recordIdempotent(tx: Tx, ctx: IdemContext, value: unknown): Promise<RecordOutcome> {
  const parsed = ctx.response.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join("/") || "the response";
    return { ok: false, why: `a write's response failed its own schema: ${where} - ${issue?.message ?? "did not match"}` };
  }
  const body = parsed.data as unknown;
  const done = await tx.update(idempotencyKeys)
    .set({
      statusCode: 200,
      response: body === null || body === undefined ? JSON_NULL : body,
      committedAt: new Date(),
      expiresAt: new Date(Date.now() + TTL_MS),
    })
    .where(and(eq(idempotencyKeys.key, ctx.idem.key), eq(idempotencyKeys.userId, ctx.idem.userId), isNull(idempotencyKeys.committedAt)))
    .returning({ key: idempotencyKeys.key });
  if (done.length === 0) return { ok: false, why: "a write's claim row was taken over by a retry while the write was still running" };
  return { ok: true, body };
}
