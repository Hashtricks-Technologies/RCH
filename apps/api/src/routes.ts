import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { API_PREFIX, type AnyRoute, type Route } from "@rch/contract";
import type { App } from "./app.js";
import { NOT_RECORDED } from "./lib/idempotency-record.js";
import { idemStore } from "./plugins/idempotency.js";

/** So a handler (or a rate-limit override, etc.) can read whether its own route is a write. */
declare module "fastify" { interface FastifyContextConfig { write?: boolean } }

type Infer<T> = T extends z.ZodTypeAny ? z.infer<T> : undefined;
export type Req<R extends AnyRoute> = FastifyRequest<{
  Params: R extends Route<infer P, z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny> ? Infer<P> : never;
  Querystring: R extends Route<z.ZodTypeAny, infer Q, z.ZodTypeAny, z.ZodTypeAny> ? Infer<Q> : never;
  Body: R extends Route<z.ZodTypeAny, z.ZodTypeAny, infer B, z.ZodTypeAny> ? Infer<B> : never;
}>;
export type Res<R extends AnyRoute> = z.infer<R["response"]>;
export type Handler<R extends AnyRoute> = (req: Req<R>, reply: FastifyReply) => Promise<Res<R>>;

/**
 * The only way a module registers a route. The manifest entry supplies method, path, schemas
 * and access; the module supplies the handler. Auth and role gating are attached here, so a
 * handler cannot forget them. Writes also pick up the idempotency preHandler; public routes
 * never need one.
 *
 * A write's handler additionally runs inside `idemStore`, which is how `withTransaction`
 * (`lib/db.ts`) knows which claim row to fill in and which schema the response must satisfy —
 * the record is then the last statement before the write's own COMMIT rather than a second
 * connection's work after it.
 *
 * The assertion afterwards is the bench check for the one shape that defeats all of it: a write
 * that builds its response *outside* any transaction (`me.patch` used to re-read the user after
 * committing). Off in production, where `onSend` still catches such a response — the pre-existing
 * behaviour — because a refused sale is worse than a narrow retry window.
 */
export function mount<R extends AnyRoute>(app: App, route: R, handler: Handler<R>, extra: { config?: Record<string, unknown> } = {}): void {
  const isWrite = route.write ?? route.method !== "GET";
  const pre: Array<(req: FastifyRequest, reply: FastifyReply) => Promise<void>> = [];
  if (route.access !== "public") pre.push(app.authenticate, app.roleGate(route.access, route.allowMcp ?? false));
  if (isWrite && route.access !== "public") pre.push(app.idempotency);
  const strict = app.config.env !== "production";
  const wrapped: Handler<R> = async (req, reply) => {
    const idem = req.idem;
    if (!idem) return handler(req, reply);
    const value = await idemStore.run({ idem, response: route.response, strict }, () => handler(req, reply));
    if (idem.recorded === false) {
      if (!strict) req.log.warn({ route: route.path }, NOT_RECORDED);
      else throw new Error(`${NOT_RECORDED} (${route.method} ${route.path})`);
    }
    return value;
  };
  app.route({
    method: route.method,
    url: API_PREFIX + route.path,
    schema: { params: route.params, querystring: route.query, body: route.body, response: { 200: route.response } },
    preHandler: pre,
    config: { write: isWrite, ...extra.config },
    handler: (isWrite && route.access !== "public" ? wrapped : handler) as never,
  });
}
