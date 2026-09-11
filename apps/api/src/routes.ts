import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { API_PREFIX, type AnyRoute, type Route } from "@rch/contract";
import type { App } from "./app.js";
import { NOT_RECORDED } from "./lib/idempotency-record.js";
import { idemStore, type IdemContext } from "./plugins/idempotency.js";

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
    const ctx: IdemContext = { idem, response: route.response, strict };
    const value = await idemStore.run(ctx, () => handler(req, reply));
    // Only a handler that *returned* reaches the assertion below. A handler that threw — the
    // refusal a `response: "optional"` write raises after its own commit, or any other 4xx —
    // rejects this await and leaves with the error, so the assertion never sees a write whose
    // answer was deliberately not recorded. That is the one shape `recorded === false` is
    // allowed to take, and the `await` is what keeps it out of here.
    //
    // `ctx.why` is the transaction's own account of why it could not record (a response its
    // schema refused, a claim taken over mid-write); without one, the write ran no transaction
    // at all. In production this is the only line that says so, so it carries both.
    if (idem.recorded === false) {
      const why = ctx.why ?? NOT_RECORDED;
      if (!strict) req.log.warn({ route: route.path, key: idem.key }, why);
      else throw new Error(`${why} (${route.method} ${route.path})`);
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
