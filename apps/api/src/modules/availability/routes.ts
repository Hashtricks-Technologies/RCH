// Availability: what a counter may sell right now, and the manual override.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { createAvailabilityService } from "./service.js";

export default fp(async (app) => {
  const svc = createAvailabilityService(app.db);
  mount(app, routes.toggleAvail, async (req) => {
    if (req.user.role === "counter") requireLoc(req, req.body.loc, "your own counter");
    return svc.toggle(req.user, req.body);
  });
}, { name: "module:availability", dependencies: ["auth", "rbac", "idempotency", "db"] });
