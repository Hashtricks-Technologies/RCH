// Availability: what a counter may sell - and what the kitchen is making - right now, and the
// manual override behind both.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { createAvailabilityService } from "./service.js";

export default fp(async (app) => {
  const svc = createAvailabilityService(app.db);
  mount(app, routes.toggleAvail, async (req) => {
    // A counter and a kitchen each own one location's switch; a role given every outlet (the
    // seeded Outlet Manager) reaches any of them.
    if (!req.actor.wide) requireLoc(req, req.body.loc, req.user.role === "prod" ? "your own kitchen" : "your own counter");
    return svc.toggle(req.actor, req.body);
  });
}, { name: "module:availability", dependencies: ["auth", "rbac", "idempotency", "db"] });
