import { and, eq, sql } from "drizzle-orm";
import { idempotencyKeys } from "../db/schema/index.js";
import type { IdemContext } from "../plugins/idempotency.js";
import type { Tx } from "./db.js";

const TTL_MS = 24 * 3600_000;
/** `response` is `jsonb not null`; a JS `null` would write an SQL NULL and break that. */
const JSON_NULL = sql`'null'::jsonb`;

/** What `mount()` and `withTransaction` both say when a write's answer never reached its own
 *  claim row. One sentence, two places, so a grep finds both. */
export const NOT_RECORDED = "a write's response was not recorded inside its own transaction";

/**
 * Write the response into the claim row **from inside the write's own transaction**, as the
 * last statement before COMMIT.
 *
 * That placement is the whole point: the row is committed by the same COMMIT that commits the
 * bill, so there is no instant at which the write has happened and the key does not know it.
 * Everything that used to stand between the two — the pod staying alive, the pool handing out a
 * second connection, the response surviving its own serializer — is out of the picture.
 *
 * The value is validated against the route's response schema first, and what is stored is the
 * *parsed* value, so a replay serialises byte-for-byte what the first attempt sent. A value the
 * schema refuses is not stored and `false` comes back: either this transaction was not the one
 * that produced the response (a write may open more than one), or the response is genuinely
 * malformed. `withTransaction` decides which of those it is.
 */
export async function recordIdempotent(tx: Tx, ctx: IdemContext, value: unknown): Promise<boolean> {
  const parsed = ctx.response.safeParse(value);
  if (!parsed.success) return false;
  const body = parsed.data as unknown;
  await tx.update(idempotencyKeys)
    .set({
      statusCode: 200,
      response: body === null || body === undefined ? JSON_NULL : body,
      committedAt: new Date(),
      expiresAt: new Date(Date.now() + TTL_MS),
    })
    .where(and(eq(idempotencyKeys.key, ctx.idem.key), eq(idempotencyKeys.userId, ctx.idem.userId)));
  return true;
}
