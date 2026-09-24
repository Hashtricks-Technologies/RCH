// Adjustment requests: what a counter asks to correct on its own shelf - raised, and decided by
// the outlet manager. No location scoping beyond the token/role checks the service itself makes
// (`requireLocOf` for a counter's own cancel): the raiser's location is always the token's.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createAdjustmentRequestsService } from "./service.js";

export default fp(async (app) => {
  const svc = createAdjustmentRequestsService(app.db);
  mount(app, routes.createAdjustmentRequest, async (req) => svc.create(req.user, req.body));
  mount(app, routes.cancelAdjustmentRequest, async (req) => svc.cancel(req.actor, req.params.id));
  mount(app, routes.approveAdjustmentRequest, async (req) => svc.approve(req.user, req.params.id));
  mount(app, routes.rejectAdjustmentRequest, async (req) => svc.reject(req.user, req.params.id, req.body));
}, { name: "module:adjustmentRequests", dependencies: ["auth", "rbac", "idempotency", "db"] });
