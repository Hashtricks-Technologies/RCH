import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createRequisitionsService } from "./service.js";

// The central store asks and procurement decides. Neither is location-scoped: there is one
// central store and one buyer, and every requisition is raised against the same shelf.
export default fp(async (app) => {
  const svc = createRequisitionsService(app.db);
  mount(app, routes.createRequisition, async (req) => svc.create(req.user, req.body));
  mount(app, routes.approveRequisition, async (req) => svc.approve(req.user, req.params.id, req.body));
  mount(app, routes.declineRequisition, async (req) => svc.decline(req.user, req.params.id, req.body));
}, { name: "module:requisitions", dependencies: ["auth", "rbac", "idempotency", "db"] });
