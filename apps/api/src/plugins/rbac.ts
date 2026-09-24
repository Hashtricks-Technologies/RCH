import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import type { Access, LocKey } from "@rch/contract";
import { admits, DESK_DEFAULTS } from "@rch/domain";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";

declare module "fastify" {
  interface FastifyInstance { roleGate: (access: Access, allowMcp: boolean, opts?: GateOptions) => (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void> }
}

type GateOptions = {
  /** Let an admin-flagged token through a route that is not `access: "admin"` - for a door the
   *  account-management page genuinely uses that is not an account-management route. `/events`
   *  (`plugins/sse.ts`) is the only one: the admin's own screens refresh live like every other. */
  admitAdmin?: boolean;
};

/** Role decides whether the route exists for you (404, like the sidebar); location decides which rows (403). */
export default fp(async (app) => {
  app.decorate("roleGate", (access: Access, allowMcp: boolean, opts: GateOptions = {}) => async (req: FastifyRequest) => {
    if (access === "public") return;
    // A super admin has no role in practice (root CLAUDE.md). Its `role`/`loc` claims are
    // placeholders the `users` row needs, so without this an admin-flagged token would pass the
    // role check below as whatever role that placeholder happens to be - every buyer route, say -
    // though no screen of its ever calls one. It reaches account management (`access: "admin"`),
    // the doors a must-change-password token may also use (sign-in, password, `/me`), and any
    // route that asks for it by name; everything else is the same 404 a missing module is.
    if (req.user.admin && access !== "admin" && !allowMcp && !opts.admitAdmin) throw new NotFoundError(`There is nothing at ${req.method} ${req.url}.`);
    // A role list, or the permission forms (`needs`, `desk`) read against the desk's seeded role
    // until each account's own role is resolved per request.
    if (typeof access === "object") {
      const r = admits(access, req.user.role, DESK_DEFAULTS[req.user.role].perms);
      if (!r.ok && r.status === 404) throw new NotFoundError(`There is nothing at ${req.method} ${req.url}.`);
      if (!r.ok) throw new ForbiddenError(r.message);
    }
    // Same shape as the role check above, on a different claim: an ordinary account without the
    // flag gets the same "nothing here" a role lacking the module gets, never a 403 that would
    // confirm the route exists.
    if (access === "admin" && !req.user.admin) throw new NotFoundError(`There is nothing at ${req.method} ${req.url}.`);
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
 * @public - consumed by Phase 2 write endpoints.
 */
export function requireLoc(req: FastifyRequest, loc: LocKey | string, what = "that location"): void {
  requireLocOf(req.user, loc, what);
}
