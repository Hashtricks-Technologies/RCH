// Register: the X, the Z and the list of past Zs - parse, scope, service, reply.
//
// Scope is decided here because every one of the three names its own outlet, and the callers
// the manifest admits answer for different sets of them:
//
//  · a role held to its own outlet (the seeded Counter Operator, or any role without every
//    outlet) - its own till and no other. Omitting `loc` is the ordinary case and means exactly
//    that; naming somebody else's is the 403 every location-scoped route gives, because reading
//    another outlet's takings is reading another outlet's takings whether or not it was meant.
//  · a role that works for every outlet (`req.actor.wide`: `all_outlets`, as the seeded Outlet
//    Manager holds) - any outlet by name, and its own desk when it names none.
//  · the super admin (`admitAdmin` in the manifest) - any outlet, but it has no till of its own,
//    so it must name one.
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { ValidationError } from "../../lib/errors.js";
import { createRegisterService } from "./service.js";

function registerOf(req: FastifyRequest, loc: string | undefined): string {
  if (req.actor.admin) {
    if (loc === undefined) throw new ValidationError("Choose the outlet whose register you want - the super admin has no counter of its own.");
    return loc;
  }
  const key = loc ?? req.user.loc;
  if (!req.actor.wide) requireLoc(req, key, "your own counter");
  return key;
}

export default fp(async (app) => {
  const svc = createRegisterService(app.db);
  mount(app, routes.xReport, async (req) => svc.xReport(req.user, registerOf(req, req.query.loc)));
  mount(app, routes.closeRegister, async (req) => {
    registerOf(req, req.body.loc);
    return svc.closeRegister(req.user, req.body);
  });
  mount(app, routes.zReports, async (req) => svc.zReports(req.user, registerOf(req, req.query.loc), req.query.days));
}, { name: "module:register", dependencies: ["auth", "rbac", "idempotency", "db"] });
