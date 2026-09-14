import fp from "fastify-plugin";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema/index.js";
import { ConflictError, ValidationError } from "../lib/errors.js";
import { JSON_NULL, TTL_MS } from "../lib/idempotency-record.js";
import { resolveClaim } from "./idempotency-claim.js";

declare module "fastify" {
  interface FastifyInstance { idempotency: (req: FastifyRequest, reply: FastifyReply) => Promise<void> }
  /** `recorded` is flipped to true by the write's own transaction (`lib/db.ts`), which is why
   *  this object is handed to `idemStore` by reference rather than copied. */
  interface FastifyRequest { idem?: { key: string; userId: string; hash: string; recorded?: boolean } }
}

/**
 * What a write's transaction needs to know to record its own outcome: which claim row is
 * this request's, and the schema the response must satisfy before it is stored.
 *
 * `strict` is `config.env !== "production"`. In development and test a response the schema
 * refuses takes the whole write down with it (the transaction rolls back), because a write
 * whose answer can never reach the client - and can never be replayed - must not stand. In
 * production the write is left alone and `onSend` records what actually went out, so a
 * response-shape bug degrades to the pre-existing behaviour instead of refusing the hospital's
 * sales - which is the path that actually ships, since the chart sets `NODE_ENV=production` in
 * every namespace.
 *
 * `why` is how the production path stays diagnosable: `withTransaction` leaves the reason the
 * record did not happen here, and `mount()` logs it beside the route and the key.
 */
export type IdemContext = { idem: NonNullable<FastifyRequest["idem"]>; response: z.ZodTypeAny; strict: boolean; why?: string };

/** Set by `mount()` around every write handler, read by `withTransaction` (`lib/db.ts`). An
 *  async-local rather than an argument, so the record lands inside the transaction without
 *  threading a context through forty-odd service signatures. */
export const idemStore = new AsyncLocalStorage<IdemContext>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A claim older than this with no response is assumed abandoned (the pod died mid-write).
 *  Kept comfortably above app.ts's `requestTimeout` (30s) so a takeover can only happen once
 *  Fastify has already killed any legitimately slow request that held the claim. */
const CLAIM_STALE_MS = 120_000;
/** `status_code = 0` is the claim marker: no real response ever carries it. */
const CLAIMED = 0;
const IN_FLIGHT = "That request is still being processed - try again in a moment.";
const hashOf = (req: FastifyRequest) => createHash("sha256").update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`).digest("hex");

/**
 * The key is claimed *before* the handler runs, and filled in *inside the write's own
 * transaction* rather than after it.
 *
 * Recording only in `onSend` left three holes. Two were closed by claiming first: two requests
 * arriving with the same key inside the same millisecond both found nothing and both executed
 * (two bills, one Idempotency-Key), and a crash between the write's COMMIT and the record left
 * no trace at all. The third is why `lib/idempotency-record.ts` exists: `onSend` runs on a
 * connection of its own, *after* the business transaction committed, so a pod that died - or a
 * pool that timed out, or a response that failed its own schema in the serializer and turned
 * into a 5xx - between COMMIT and the hook either left the row a bare claim or, worse, deleted
 * it, and the client's retry ran the write a second time. The record is now the last statement
 * before COMMIT: it either commits with the write or does not exist.
 *
 * So the preHandler inserts a claim row and only proceeds while it holds one - `resolveClaim`
 * (idempotency-claim.ts) makes that call from three ops (insert / lookup / takeover) built
 * from Drizzle here:
 *
 * - insert wins        → this request owns the key, the handler runs, its transaction fills the
 *                        row in and stamps `committed_at`.
 * - row has a response → replay it verbatim.
 * - row is a fresh claim → someone else is mid-write: 409, come back in a moment.
 * - row is a stale claim → the owner never returned: take it over and run - unless it carries
 *   `committed_at`, which says the write did commit and only the response hooks were lost.
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
    // array - auth → roleGate → idempotency - sits ahead of), so a request that ends up
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
      // a second would-be taker's WHERE no longer matches. A row carrying `committed_at` is
      // never taken over however old it is - the write behind it committed, so re-running it
      // would be the second bill this whole plugin exists to prevent.
      tryTakeover: async () => {
        const taken = await app.db.update(idempotencyKeys)
          .set({ createdAt: new Date() })
          .where(and(mine, eq(idempotencyKeys.statusCode, CLAIMED), isNull(idempotencyKeys.committedAt), lt(idempotencyKeys.createdAt, staleBefore())))
          .returning({ key: idempotencyKeys.key });
        return taken.length > 0;
      },
    });

    switch (outcome.kind) {
      case "proceed": req.idem = { key, userId, hash, recorded: false }; return;
      case "replay": reply.header("idempotency-replayed", "true").code(outcome.statusCode).send(outcome.response); return;
      case "conflict": throw new ConflictError("That Idempotency-Key was already used for a different request.");
      case "in_progress": throw new ConflictError(IN_FLIGHT);
    }
  });
  app.addHook("onSend", async (req, reply, payload) => {
    await idemHooks.recordAfterSend(app.db, req, reply, payload);
    return payload;
  });
}, { name: "idempotency", dependencies: ["auth", "db"] });

/**
 * The `onSend` body, reached through this object rather than called directly so a test can
 * replace it with a no-op - that is how "the pod died between COMMIT and the response hooks"
 * is staged (idempotency.test.ts). Spying the bare function export would not do it: the hook's
 * own call resolves the module's local binding, not the namespace the test can see.
 *
 * It is now the *fallback*, not the record. A write that recorded itself inside its own
 * transaction is left completely alone; what is left for this hook is the outcomes no
 * transaction produced - a refusal (4xx), a 5xx or a 429 whose claim must go, and (in
 * production only) a write whose response was not recorded inside its transaction. Every
 * statement it makes is guarded `committed_at is null`, so it can never overwrite or delete a
 * committed outcome.
 */
export const idemHooks = {
  async recordAfterSend(db: Db, req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<void> {
    if (!req.idem || reply.getHeader("idempotency-replayed")) return;
    // The write's own transaction already stored the response and stamped `committed_at`.
    if (req.idem.recorded && reply.statusCode < 300) return;
    const mine = and(eq(idempotencyKeys.key, req.idem.key), eq(idempotencyKeys.userId, req.idem.userId));
    const uncommitted = and(mine, isNull(idempotencyKeys.committedAt));
    try {
      // A 5xx, or a 429 from the rate limiter, is not an outcome worth replaying: the write
      // never happened. The limiter (plugins/security.ts) runs at `preHandler` *after* this
      // claim is inserted, so a throttled write already owns a claim row by the time it is
      // rejected - recording the 429 into it would replay "too many requests" as the write's
      // permanent answer for the rest of the key's TTL, and the write itself would never run.
      // Drop the claim instead, so the client's retry (same key, once the budget refills) is a
      // clean first attempt rather than a stuck replay.
      if (reply.statusCode >= 500 || reply.statusCode === 429) { await db.delete(idempotencyKeys).where(uncommitted); return; }
      let body: unknown = null;
      if (typeof payload === "string") {
        try { body = JSON.parse(payload); } catch { body = null; }
      } else {
        body = payload ?? null;
      }
      await db.update(idempotencyKeys)
        .set({ statusCode: reply.statusCode, response: body === null ? JSON_NULL : body, expiresAt: new Date(Date.now() + TTL_MS) })
        .where(uncommitted);
    } catch (err) {
      req.log.warn({ err, route: req.routeOptions.url }, "idempotency record not stored");
    }
  },
};

/** How many rows one DELETE of the nightly sweep takes. Ten thousand is small enough that each
 *  statement is short and commits as it goes, and large enough that a normal night is one or two
 *  of them. */
const PURGE_BATCH = 10_000;

/**
 * The nightly sweep (cli/purge.ts), a bounded batch at a time. One skipped run is a day of keys,
 * so this can meet a very large backlog, and a single unbounded DELETE would hold one transaction
 * and one set of row locks over the whole of it - blocking the writes that are inserting claims
 * behind it, and building a rollback record that gets longer the further it gets. A loop commits
 * each batch, so a job killed halfway has already done half the work and tomorrow's run finishes
 * it.
 *
 * `ctid in (select ctid … limit n)` is how to say "any n of the matching rows": ctid is the
 * physical address of a tuple, so the subquery walks the index on expires_at and the delete goes
 * straight at those tuples. The loop stops on a batch that comes back short - the one signal that
 * the previous statement emptied the set.
 *
 * `batch` is a parameter so a test can make it smaller than the work and prove the loop; nothing
 * in production passes it.
 */
export async function purgeIdempotencyKeys(db: Db, batch: number = PURGE_BATCH): Promise<number> {
  // One cutoff for the whole sweep: `new Date()` inside the loop would walk forward between
  // batches and make "what this run deleted" a moving target.
  const cutoff = new Date();
  let total = 0;
  for (;;) {
    const r = await db.delete(idempotencyKeys).where(
      sql`ctid in (select ctid from ${idempotencyKeys} where ${lt(idempotencyKeys.expiresAt, cutoff)} limit ${batch})`,
    );
    const n = r.rowCount ?? 0;
    total += n;
    if (n < batch) return total;
  }
}
