// Production: everything the Central Kitchen does. The two ways it puts stock on a ticket — an
// order it was asked for and a tray it decided to push out — and the two ways it works: the
// board's own statuses, and the batch that turns raw materials into finished units.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { createProductionService } from "./service.js";

export default fp(async (app) => {
  const svc = createProductionService(app.db);
  // Neither is location-scoped: the prod role has one kitchen, and both rules pin `from` to it.
  mount(app, routes.dispatchProdOrder, async (req) => svc.dispatch(req.user, req.params.id));
  mount(app, routes.distribute, async (req) => svc.distribute(req.user, req.body));
  // Neither is location-scoped: the prod role has one kitchen, and every rule here pins the
  // location to it rather than taking one from the caller.
  mount(app, routes.setOrderStatus, async (req) => svc.setStatus(req.user, req.params.id, req.body.st));
  mount(app, routes.makeBatch, async (req) => svc.makeBatch(req.user, req.body));
  // ---- prod-order raise ---- the one route here that IS location-scoped, and the only one
  // open to a role other than `prod`. A counter raises for its own outlet and nowhere else, so
  // `from` comes off the token — a body naming another shop is refused rather than quietly
  // rewritten, because an operator who typed it meant it. A manager supervises all three, so
  // theirs is the body's and the service is what checks it is an outlet at all.
  mount(app, routes.createProdOrder, async (req) => {
    if (req.user.role !== "counter") return svc.raise(req.user, req.body);
    if (req.body.from) requireLoc(req, req.body.from, "your own counter");
    return svc.raise(req.user, { ...req.body, from: req.user.loc });
  });
}, { name: "module:production", dependencies: ["auth", "rbac", "idempotency", "db"] });
