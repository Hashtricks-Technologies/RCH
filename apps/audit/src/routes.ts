import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { API_PREFIX, serviceOf, type AnyRoute, type Route } from "@rch/contract";
import type { AuditApp } from "./app.js";

type Infer<T> = T extends z.ZodTypeAny ? z.infer<T> : undefined;
export type Req<R extends AnyRoute> = FastifyRequest<{
  Params: R extends Route<infer P, z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny> ? Infer<P> : never;
  Querystring: R extends Route<z.ZodTypeAny, infer Q, z.ZodTypeAny, z.ZodTypeAny> ? Infer<Q> : never;
}>;
export type Handler<R extends AnyRoute> = (req: Req<R>, reply: FastifyReply) => Promise<z.infer<R["response"]>>;

/** `"<METHOD> <manifest path>"` for every route mounted, so a test can hold it against the
 *  manifest's `service: "audit"` entries. */
export const mountedRoutes = new Set<string>();

/**
 * The only way a module registers a route here. The manifest supplies method, path and schemas; the
 * module supplies the handler.
 *
 * Every route this service serves is `access: "admin"`. A route tagged for another service, or one
 * that is not admin-only, is refused at boot rather than served with the wrong gate. The gates run
 * on `onRequest`, ahead of validation, so an account without the flag gets the same 404 for a
 * malformed query as for a good one and never learns the route exists.
 */
export function mount<R extends AnyRoute>(app: AuditApp, route: R, handler: Handler<R>): void {
  const key = `${route.method} ${route.path}`;
  const service = serviceOf(route);
  if (service !== "audit") throw new Error(`${key} is served by the ${service} service, not the audit service.`);
  if (route.access !== "admin") throw new Error(`${key} is not an admin route, and the audit service serves nothing else.`);
  // A slot the manifest leaves unset is left off entirely (FSTWRN001; see apps/api/src/routes.ts).
  const schema = {
    ...(route.params ? { params: route.params } : {}),
    ...(route.query ? { querystring: route.query } : {}),
    response: { 200: route.response },
  };
  app.route({
    method: route.method,
    url: API_PREFIX + route.path,
    schema,
    onRequest: [app.authenticate, app.requireAdmin],
    handler: handler as never,
  });
  mountedRoutes.add(key);
}
