import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { API_PREFIX, type AnyRoute, type Route } from "@rch/contract";
import type { App } from "./app.js";

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
 * handler cannot forget them. Writes also pick up the idempotency preHandler (Task 10 fills
 * in its body); public routes never need one.
 */
export function mount<R extends AnyRoute>(app: App, route: R, handler: Handler<R>, extra: { config?: Record<string, unknown> } = {}): void {
  const isWrite = route.write ?? route.method !== "GET";
  const pre: Array<(req: FastifyRequest, reply: FastifyReply) => Promise<void>> = [];
  if (route.access !== "public") pre.push(app.authenticate, app.roleGate(route.access, route.allowMcp ?? false));
  if (isWrite && route.access !== "public") pre.push(app.idempotency);
  app.route({
    method: route.method,
    url: API_PREFIX + route.path,
    schema: { params: route.params, querystring: route.query, body: route.body, response: { 200: route.response } },
    preHandler: pre,
    config: { write: isWrite, ...extra.config },
    handler: handler as never,
  });
}
