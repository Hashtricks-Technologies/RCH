// Register: the X, the Z and the list of past Zs - parse, scope, service, reply.
//
// Scope is decided here because every one of the three names its own outlet, and the two roles
// the manifest admits answer for different sets of them:
//
//  · `counter` - their own till and no other. Omitting `loc` is the ordinary case and means
//                exactly that; naming somebody else's is the 403 every location-scoped route
//                gives, because a counter reading another outlet's takings is a counter reading
//                another outlet's takings whether or not they meant to.
//  · `manager` - hospital-wide, so any outlet by name, and their own desk when they name none.
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { createRegisterService } from "./service.js";

function registerOf(req: FastifyRequest, loc: string | undefined): string {
  const key = loc ?? req.user.loc;
  if (req.user.role !== "manager") requireLoc(req, key, "your own counter");
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
