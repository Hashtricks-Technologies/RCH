// The buyer's order: drafted off the procurement list, edited while it is a draft, sent to the
// vendor, and cancelled back onto the list. Receipt is `grn`'s — it writes different columns of
// the same two tables and carries the store keeper on its role list as well as the buyer.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createPurchaseOrdersService } from "./service.js";

export default fp(async (app) => {
  const svc = createPurchaseOrdersService(app.db);
  mount(app, routes.createPo, async (req) => svc.create(req.user, req.body));
  mount(app, routes.updatePoLine, async (req) => svc.updateLine(req.user, req.params.id, req.params.n, req.body));
  mount(app, routes.removePoLine, async (req) => svc.removeLine(req.user, req.params.id, req.params.n));
  mount(app, routes.patchPo, async (req) => svc.patch(req.user, req.params.id, req.body));
  mount(app, routes.sendPo, async (req) => svc.send(req.user, req.params.id));
  mount(app, routes.cancelPo, async (req) => svc.cancel(req.user, req.params.id, req.body));
}, { name: "module:purchaseorders", dependencies: ["auth", "rbac", "idempotency", "db"] });
