import fp from "fastify-plugin";
import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema/index.js";
import { ConflictError, ValidationError } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyInstance { idempotency: (req: FastifyRequest, reply: FastifyReply) => Promise<void> }
  interface FastifyRequest { idem?: { key: string; userId: string; hash: string } }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TTL_MS = 24 * 3600_000;
const hashOf = (req: FastifyRequest) => createHash("sha256").update(`${req.method} ${req.url}\n${JSON.stringify(req.body ?? null)}`).digest("hex");

export default fp(async (app) => {
  app.decorate("idempotency", async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.headers["idempotency-key"];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || !UUID.test(key)) throw new ValidationError("Every write needs an Idempotency-Key header holding a UUID.");
    const userId = req.user.sub; const hash = hashOf(req);
    const [hit] = await app.db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.userId, userId)));
    if (hit) {
      if (hit.requestHash !== hash) throw new ConflictError("That Idempotency-Key was already used for a different request.");
      reply.header("idempotency-replayed", "true").code(hit.statusCode).send(hit.response);
      return;
    }
    req.idem = { key, userId, hash };
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (!req.idem || reply.statusCode >= 500 || reply.getHeader("idempotency-replayed")) return payload;
    let body: unknown = null;
    if (typeof payload === "string") {
      try { body = JSON.parse(payload); } catch { body = null; }
    } else {
      body = payload ?? null;
    }
    try {
      await app.db.insert(idempotencyKeys).values({ key: req.idem.key, userId: req.idem.userId, requestHash: req.idem.hash, statusCode: reply.statusCode, response: body, expiresAt: new Date(Date.now() + TTL_MS) }).onConflictDoNothing();
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
