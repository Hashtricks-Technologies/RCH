// Availability: what a counter may sell — and what the kitchen is making — right now, and the
// manual override behind both.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { createAvailabilityService } from "./service.js";

export default fp(async (app) => {
  const svc = createAvailabilityService(app.db);
  mount(app, routes.toggleAvail, async (req) => {
    // A counter and a kitchen each own one location's switch; a manager reaches every outlet.
    if (req.user.role === "counter") requireLoc(req, req.body.loc, "your own counter");
    if (req.user.role === "prod") requireLoc(req, req.body.loc, "your own kitchen");
    return svc.toggle(req.user, req.body);
  });
}, { name: "module:availability", dependencies: ["auth", "rbac", "idempotency", "db"] });
