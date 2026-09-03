import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import type { Access, LocKey } from "@rch/contract";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyInstance { roleGate: (access: Access, allowMcp: boolean) => (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void> }
}

/** Role decides whether the route exists for you (404, like the sidebar); location decides which rows (403). */
export default fp(async (app) => {
  app.decorate("roleGate", (access: Access, allowMcp: boolean) => async (req: FastifyRequest) => {
    if (access === "public") return;
    if (Array.isArray(access) && !access.includes(req.user.role)) throw new NotFoundError(`There is nothing at ${req.method} ${req.url}.`);
    if (req.user.mcp && !allowMcp) throw new ForbiddenError("Change your password before you carry on.");
  });
}, { name: "rbac", dependencies: ["auth"] });

/**
 * For location-scoped writes: the caller's location must be the row's.
 * @public — consumed by Phase 2 write endpoints (spec §9.2).
 */
export function requireLoc(req: FastifyRequest, loc: LocKey | string, what = "that location"): void {
  if (req.user.loc !== loc) throw new ForbiddenError(`You can only do this for ${what}.`);
}
