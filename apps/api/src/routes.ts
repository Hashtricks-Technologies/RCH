import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { API_PREFIX, routes, serviceOf, type AnyRoute, type Route } from "@rch/contract";
import type { App } from "./app.js";
import { auditContextOf } from "./lib/audit.js";
import { NOT_RECORDED } from "./lib/idempotency-record.js";
import { idemStore, type IdemContext } from "./plugins/idempotency.js";

/** So a handler (or a rate-limit override, etc.) can read whether its own route is a write - and
 *  so `plugins/audit.ts` can tell, from the request alone, that a route is audited and what the
 *  trail calls it. */
declare module "fastify" { interface FastifyContextConfig { write?: boolean; audit?: { action: string; method: string; path: string } } }

/** Manifest entry → its name. `mount()` is handed the route object, and the audit trail names a
 *  write by its manifest key (`pay`, `savePrice`) - the key `AUDIT_LABELS` is written against. */
const ROUTE_NAMES = new Map<AnyRoute, string>(Object.entries(routes).map(([name, r]) => [r as AnyRoute, name]));

/** Every non-public manifest write `mount()` has wrapped, by name. `modules/audit-capture.test.ts`
 *  holds it equal to the manifest's own list of API writes, so a write that reached the server
 *  some other way - and so escaped the audit trail - fails the suite. */
export const mountedWrites = new Set<string>();

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
 * (`lib/db.ts`) knows which claim row to fill in and which schema the response must satisfy -
 * the record is then the last statement before the write's own COMMIT rather than a second
 * connection's work after it.
 *
 * The assertion afterwards is the bench check for the one shape that defeats all of it: a write
 * that builds its response *outside* any transaction (`me.patch` used to re-read the user after
 * committing). Off in production, where `onSend` still catches such a response - the pre-existing
 * behaviour - because a refused sale is worse than a narrow retry window.
 *
 * Every non-public write is audited. The route's config names it for `plugins/audit.ts`, and the
 * handler runs with an audit context (`req.audit`, the same object as the idempotency context's
 * `audit`) from which the write's own transaction stores its `done` event. A route from the audit
 * service's half of the manifest is refused outright: this process holds no audit log to answer it
 * from.
 */
export function mount<R extends AnyRoute>(app: App, route: R, handler: Handler<R>, extra: { config?: Record<string, unknown> } = {}): void {
  if (serviceOf(route) !== "api") throw new Error(`${route.method} ${route.path} is served by the ${serviceOf(route)} service, not the API`);
  const isWrite = route.write ?? route.method !== "GET";
  const audited = isWrite && route.access !== "public";
  const name = ROUTE_NAMES.get(route);
  // A test-only route is not in the manifest. It is audited all the same, under its method and path.
  const audit = { action: (name ?? `${route.method} ${route.path}`).slice(0, 64), method: route.method, path: route.path };
  if (audited && name) mountedWrites.add(name);
  const pre: Array<(req: FastifyRequest, reply: FastifyReply) => Promise<void>> = [];
  if (route.access !== "public") pre.push(app.authenticate, app.roleGate(route.access, route.allowMcp ?? false, { admitAdmin: route.admitAdmin ?? false }));
  if (audited) pre.push(app.idempotency);
  const strict = app.config.env !== "production";
  const wrapped: Handler<R> = async (req, reply) => {
    const idem = req.idem;
    if (!idem) return handler(req, reply);
    req.audit = auditContextOf(req, audit);
    const ctx: IdemContext = { idem, response: route.response, strict, audit: req.audit };
    const value = await idemStore.run(ctx, () => handler(req, reply));
    // Only a handler that *returned* reaches the assertion below. A handler that threw - the
    // refusal a `response: "optional"` write raises after its own commit, or any other 4xx -
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
  // Fastify warns (FSTWRN001) when a schema key is present but `undefined` - it cannot tell
  // "no validation for this slot" from "the caller forgot one" - so a slot the manifest leaves
  // unset is left off the object entirely rather than set to `undefined`. No validation ran for
  // it either way; only the warning changes.
  const schema = {
    ...(route.params ? { params: route.params } : {}),
    ...(route.query ? { querystring: route.query } : {}),
    ...(route.body ? { body: route.body } : {}),
    response: { 200: route.response },
  };
  app.route({
    method: route.method,
    url: API_PREFIX + route.path,
    schema,
    preHandler: pre,
    config: { write: isWrite, ...(audited ? { audit } : {}), ...extra.config },
    handler: (audited ? wrapped : handler) as never,
  });
}
