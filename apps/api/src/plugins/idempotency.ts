import fp from "fastify-plugin";
import { createHash } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema/index.js";
import { ConflictError, ValidationError } from "../lib/errors.js";
import { resolveClaim } from "./idempotency-claim.js";

declare module "fastify" {
  interface FastifyInstance { idempotency: (req: FastifyRequest, reply: FastifyReply) => Promise<void> }
  interface FastifyRequest { idem?: { key: string; userId: string; hash: string } }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TTL_MS = 24 * 3600_000;
/** A claim older than this with no response is assumed abandoned (the pod died mid-write).
 *  Kept comfortably above app.ts's `requestTimeout` (30s) so a takeover can only happen once
 *  Fastify has already killed any legitimately slow request that held the claim. */
const CLAIM_STALE_MS = 120_000;
/** `status_code = 0` is the claim marker: no real response ever carries it. */
const CLAIMED = 0;
const IN_FLIGHT = "That request is still being processed — try again in a moment.";
const hashOf = (req: FastifyRequest) => createHash("sha256").update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`).digest("hex");
/** `response` is `jsonb not null`, so an empty body has to be stored as the JSON literal
 *  `null` — handing drizzle a JS `null` would write an SQL NULL and break the constraint. */
const JSON_NULL = sql`'null'::jsonb`;

/**
 * The key is claimed *before* the handler runs, not recorded after it. Recording only in
 * `onSend` left two holes: two requests arriving with the same key inside the same millisecond
 * both found nothing and both executed (two bills, one Idempotency-Key), and a crash between
 * the write's COMMIT and the record leaving no trace at all, so the client's retry ran the
 * write a second time.
 *
 * So the preHandler inserts a claim row and only proceeds while it holds one — `resolveClaim`
 * (idempotency-claim.ts) makes that call from three ops (insert / lookup / takeover) built
 * from Drizzle here:
 *
 * - insert wins        → this request owns the key, the handler runs, `onSend` fills the row in.
 * - row has a response → replay it verbatim.
 * - row is a fresh claim → someone else is mid-write: 409, come back in a moment.
 * - row is a stale claim → the owner never returned: take it over and run.
 * - row has a different hash → the key was reused for a different request: 409, as before.
 * - lookup finds nothing (purged from under us, e.g. `onSend` deleting a 429/503's claim) →
 *   never proceed bare; retry the insert instead, since only holding a row lets us proceed.
 */
export default fp(async (app) => {
  app.decorate("idempotency", async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.headers["idempotency-key"];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || !UUID.test(key)) throw new ValidationError("Every write needs an Idempotency-Key header holding a UUID.");
    const userId = req.user.sub; const hash = hashOf(req);
    const mine = and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId));

    // This preHandler runs before the global rate limiter (plugins/security.ts registers it
    // with `hook: "preHandler"`, keyed on `req.user.sub`, which this route's own preHandler
    // array — auth → roleGate → idempotency — sits ahead of), so a request that ends up
    // throttled still performs this claim INSERT first. That is accepted deliberately: undoing
    // the claim would mean reordering the limiter ahead of authentication, which would key it
    // on IP instead of user again (see security.ts's comment). The claim briefly exists, then
    // `onSend` below deletes it once the 429 lands, so nothing is left to replay.
    const staleBefore = () => new Date(Date.now() - CLAIM_STALE_MS);
    const outcome = await resolveClaim({
      requestHash: hash,
      staleMs: CLAIM_STALE_MS,
      now: () => Date.now(),
      // onConflictDoNothing().returning() is the unique-violation branch without the thrown
      // error: zero rows back means the primary key was already there.
      tryInsert: async () => {
        const r = await app.db.insert(idempotencyKeys)
          .values({ key, userId, requestHash: hash, statusCode: CLAIMED, response: JSON_NULL, expiresAt: new Date(Date.now() + TTL_MS) })
          .onConflictDoNothing()
          .returning({ key: idempotencyKeys.key });
        return r.length > 0;
      },
      lookup: async () => {
        const [hit] = await app.db.select().from(idempotencyKeys).where(mine);
        return hit;
      },
      // Take the abandoned claim over, atomically: whoever re-stamps `created_at` owns it, and
      // a second would-be taker's WHERE no longer matches.
      tryTakeover: async () => {
        const taken = await app.db.update(idempotencyKeys)
          .set({ createdAt: new Date() })
          .where(and(mine, eq(idempotencyKeys.statusCode, CLAIMED), lt(idempotencyKeys.createdAt, staleBefore())))
          .returning({ key: idempotencyKeys.key });
        return taken.length > 0;
      },
    });

    switch (outcome.kind) {
      case "proceed": req.idem = { key, userId, hash }; return;
      case "replay": reply.header("idempotency-replayed", "true").code(outcome.statusCode).send(outcome.response); return;
      case "conflict": throw new ConflictError("That Idempotency-Key was already used for a different request.");
      case "in_progress": throw new ConflictError(IN_FLIGHT);
    }
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.idem || reply.getHeader("idempotency-replayed")) return payload;
    const mine = and(eq(idempotencyKeys.key, req.idem.key), eq(idempotencyKeys.userId, req.idem.userId));
    try {
      // A 5xx, or a 429 from the rate limiter, is not an outcome worth replaying: the write
      // never happened. The limiter (plugins/security.ts) runs at `preHandler` *after* this
      // claim is inserted, so a throttled write already owns a claim row by the time it is
      // rejected - recording the 429 into it would replay "too many requests" as the write's
      // permanent answer for the rest of the key's TTL, and the write itself would never run.
      // Drop the claim instead, so the client's retry (same key, once the budget refills) is a
      // clean first attempt rather than a stuck replay.
      if (reply.statusCode >= 500 || reply.statusCode === 429) { await app.db.delete(idempotencyKeys).where(mine); return payload; }
      let body: unknown = null;
      if (typeof payload === "string") {
        try { body = JSON.parse(payload); } catch { body = null; }
      } else {
        body = payload ?? null;
      }
      await app.db.update(idempotencyKeys)
        .set({ statusCode: reply.statusCode, response: body === null ? JSON_NULL : body, expiresAt: new Date(Date.now() + TTL_MS) })
        .where(mine);
    } catch (err) {
      req.log.warn({ err }, "idempotency record not stored");
    }
    return payload;
  });
}, { name: "idempotency", dependencies: ["auth", "db"] });

export async function purgeIdempotencyKeys(db: Db): Promise<number> {
  const r = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, new Date()));
  return r.rowCount ?? 0;
}
