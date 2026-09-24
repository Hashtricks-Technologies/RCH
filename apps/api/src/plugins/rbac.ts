import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import type { Access, LocKey, Permissions } from "@rch/contract";
import { admits } from "@rch/domain";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "../lib/errors.js";
import type { AccessClaims } from "./auth.js";

/** The caller as a handler should read it: the token's claims, plus what the account's role lets
 *  it do right now (`perms`, read per request through `app.access`, never from the token) and
 *  whether this request runs hospital-wide (`wide`). */
export type Actor = AccessClaims & { perms: Permissions; wide: boolean };

declare module "fastify" {
  interface FastifyInstance { roleGate: (access: Access, allowMcp: boolean, opts?: GateOptions) => (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void> }
  /** Set by `roleGate` on every route that is not `access: "public"`, the way `req.user` is set by
   *  `authenticate`. */
  interface FastifyRequest { actor: Actor }
}

type GateOptions = {
  /** Let an admin-flagged token through a route that is not `access: "admin"`. `mount()` passes
   *  the manifest's own `admitAdmin` (the register's X, Z list and close); `/events`
   *  (`plugins/sse.ts`) passes it by hand, because the admin's own screens refresh live too. */
  admitAdmin?: boolean;
};

/** A super admin holds no role and so no permissions; where it is admitted it is admitted past
 *  them, and it acts for whichever outlet it names. */
const NO_PERMS: Permissions = { f: {}, a: [] };

const nothingAt = (req: FastifyRequest) => new NotFoundError(`There is nothing at ${req.method} ${req.url}.`);

/**
 * Whether the route exists for you (404, like the sidebar), whether you may use it (403, with the
 * sentence saying what you hold), and which rows (403, by location - `requireLoc`).
 *
 * In order: a public route passes. An admin route wants the admin claim, else 404. An admin token
 * anywhere else is a 404 unless the route admits it (`allowMcp`, `admitAdmin`) - a super admin has
 * no role in practice, and its `role`/`loc` claims are placeholders the `users` row needs. Every
 * other token has its role resolved from `app.access`: an account whose role is gone, switched
 * off, or on another desk than the token says is a 401, so the browser refreshes (and gets a
 * token for the account as it now stands). Then the route's own access decides.
 */
export default fp(async (app) => {
  app.decorate("roleGate", (access: Access, allowMcp: boolean, opts: GateOptions = {}) => async (req: FastifyRequest) => {
    if (access === "public") return;
    const claims = req.user;
    if (access === "admin" || claims.admin) {
      if (access === "admin" ? !claims.admin : !allowMcp && !opts.admitAdmin) throw nothingAt(req);
      req.actor = { ...claims, perms: NO_PERMS, wide: true };
    } else {
      const role = await app.access.of(claims.sub);
      if (!role || !role.active || role.desk !== claims.role) throw new UnauthenticatedError("Your account was changed - sign in again.", "role changed");
      // `admits` (@rch/domain) is the rule for every form: `any`, `{ desk }` and `{ needs }`.
      const verdict = admits(access, role.desk, role.perms);
      if (!verdict.ok) throw verdict.status === 404 ? nothingAt(req) : new ForbiddenError(verdict.message);
      req.actor = { ...claims, perms: role.perms, wide: verdict.wide };
    }
    if (claims.mcp && !allowMcp) throw new ForbiddenError("Change your password before you carry on.");
  });
}, { name: "rbac", dependencies: ["auth", "access"] });

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
