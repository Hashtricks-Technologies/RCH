import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createCatalogService } from "./service.js";

export default fp(async (app) => {
  const svc = createCatalogService(app.db);
  mount(app, routes.savePrice, async (req) => svc.savePrice(req.params.list, req.params.it, req.body.price));
  mount(app, routes.addMenuItem, async (req) => svc.addMenuItem(req.params.loc, req.body.it));
  mount(app, routes.removeMenuItem, async (req) => svc.removeMenuItem(req.params.loc, req.params.it));
  // The item master's own module: a price, a menu line, and - from Phase 5 - a new line on it.
  mount(app, routes.createItem, async (req) => svc.createItem(req.user, req.body));
  // ---- item patch ----
  // And the way back: an existing line edited or retired. Which fields the caller's own role may
  // move is the service's rule, from `ITEM_FIELD_ROLES` - the manifest opens the door to all
  // four desks, and each of them reads a sentence when it reaches for the other's box.
  mount(app, routes.patchItem, async (req) => svc.patchItem(req.user, req.params.it, req.body));
}, { name: "module:catalog", dependencies: ["auth", "rbac", "idempotency", "db"] });
