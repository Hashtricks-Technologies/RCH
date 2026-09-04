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

/** For a location-scoped write whose location is only known once the document is read: a
 *  handover carries a ticket id and nothing else, so the row decides, not the request. */
export function requireLocOf(claims: { loc: string }, loc: string, what = "that location"): void {
  if (claims.loc !== loc) throw new ForbiddenError(`You can only do this for ${what}.`);
}

/**
 * For a location-scoped write whose location is in the request.
 * @public — consumed by Phase 2 write endpoints (spec §9.2).
 */
export function requireLoc(req: FastifyRequest, loc: LocKey | string, what = "that location"): void {
  requireLocOf(req.user, loc, what);
}
