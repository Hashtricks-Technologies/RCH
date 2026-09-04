import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createGrnService } from "./service.js";

// The store keeper's delivery.
export default fp(async (app) => {
  const svc = createGrnService(app.db);
  // Buying's one ledger write, and the door that gives an undelivered balance back. The store
  // keeper receives at the door and the buyer receives against the order they raised.
  mount(app, routes.receivePo, async (req) => svc.receive(req.user, req.params.id, req.body));
  mount(app, routes.closePoShort, async (req) => svc.closeShort(req.user, req.params.id, req.body));
}, { name: "module:grn", dependencies: ["auth", "rbac", "idempotency", "db"] });
