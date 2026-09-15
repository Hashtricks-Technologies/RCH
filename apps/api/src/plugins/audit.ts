import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuditOutcome } from "@rch/contract";
import { auditContextOf, auditEventOf, insertAuditEvent, writeOutcomeOf } from "../lib/audit.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Resolves once every audit event this app is still storing has been stored or given up on.
     *  A test awaits it before reading the outbox; `onClose` awaits it before the pool goes. */
    auditSettled: () => Promise<void>;
  }
}

/** A JSON reply body as sent, or null for anything that is not one. */
const parsed = (payload: unknown): unknown => {
  if (typeof payload !== "string") return null;
  try { return JSON.parse(payload) as unknown; } catch { return null; }
};
/** The sentence an error envelope carried - the 5xx's "Reference <request id>" line included. */
const envelopeMessage = (body: unknown): string => {
  const m = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === "string" ? m : "";
};
const outcomeOf = (status: number): AuditOutcome => (status < 400 ? "done" : status < 500 ? "refused" : "error");

/**
 * Every audited request that did not store its own event inside a transaction gets one here, once
 * the reply has gone: a refusal (400-499), an error (>= 500), and production's fallback - a write
 * whose answer was not recorded in a transaction and went out anyway (status < 400).
 *
 * Audited means `mount()` named the route in its config: every non-public write. A write that
 * committed its own `done` event (`req.audit.recorded`) is skipped, and so are two replies that are
 * not events: a **401**, because the client refreshes its token and retries, and the retry is the
 * event; and a **replay** (`idempotency-replayed`), because the original is already logged.
 *
 * A refusal is recorded only when a valid token names the caller. Fastify validates the body before
 * any preHandler, so a malformed request is refused ahead of the route's own token check; the token
 * is verified here instead, quietly, and a signed-in caller is still named. A request nobody can be
 * named for records nothing: anyone on the internet could otherwise write rows into a trail that is
 * kept forever. A failed sign-in is the exception, and `modules/auth` records it itself.
 *
 * The insert runs on the pool after the response, so it never slows or changes a reply. A failure
 * is logged at `error` with the request id and swallowed.
 */
export default fp(async (app) => {
  const sent = new WeakMap<FastifyRequest, unknown>();
  const inflight = new Set<Promise<void>>();

  // `onResponse` has the status but not the body, and the production fallback reads its sentence
  // out of the body, so the body is kept for exactly the requests that may still need it.
  app.addHook("onSend", async (req, _reply, payload) => {
    if (req.routeOptions.config.audit && !req.audit?.recorded) sent.set(req, payload);
    return payload;
  });

  async function store(req: FastifyRequest, reply: FastifyReply, route: { action: string; method: string; path: string }): Promise<void> {
    const status = reply.statusCode;
    const body = parsed(sent.get(req));
    if (!req.audit && !(req as { user?: unknown }).user) {
      try { await app.authenticate(req, reply); } catch { /* no verifiable token: the event has no actor */ }
    }
    const a = req.audit ?? auditContextOf(req, route);
    if (a.actorId === null) return;
    const outcome = outcomeOf(status);
    const w = outcome === "done" ? writeOutcomeOf(body) : { result: null, changed: [], message: req.refusal?.message ?? envelopeMessage(body) };
    await insertAuditEvent(app.db, await auditEventOf(app.db, a, {
      outcome, status, message: w.message, cause: outcome === "refused" ? req.refusal?.cause ?? null : null, result: w.result, changed: w.changed,
    }));
  }

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.config.audit;
    if (!route || req.audit?.recorded) return;
    if (reply.statusCode === 401 || reply.getHeader("idempotency-replayed")) return;
    const job = store(req, reply, route).catch((err: unknown) => {
      req.log.error({ err, requestId: req.id, action: route.action }, "audit event not stored");
    });
    inflight.add(job);
    try { await job; } finally { inflight.delete(job); }
  });

  // `setImmediate` first: a caller that has just had its reply may be ahead of the hook that
  // starts the insert, and one turn of the loop lets every such hook register its job.
  app.decorate("auditSettled", async () => {
    await new Promise<void>((r) => { setImmediate(r); });
    await Promise.all(inflight);
  });
  app.addHook("onClose", async () => { await Promise.all(inflight); });
}, { name: "audit", dependencies: ["errors", "db", "auth"] });
