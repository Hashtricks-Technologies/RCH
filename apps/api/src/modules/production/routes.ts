// Production: the two ways the kitchen puts stock on a ticket — an order it was asked for, and
// a tray it decided to push out. Batches and the board's own statuses are Phase 4.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createProductionService } from "./service.js";

export default fp(async (app) => {
  const svc = createProductionService(app.db);
  // Neither is location-scoped: the prod role has one kitchen, and both rules pin `from` to it.
  mount(app, routes.dispatchProdOrder, async (req) => svc.dispatch(req.user, req.params.id));
  mount(app, routes.distribute, async (req) => svc.distribute(req.user, req.body));
}, { name: "module:production", dependencies: ["auth", "rbac", "idempotency", "db"] });
