import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createCatalogService } from "./service.js";

export default fp(async (app) => {
  const svc = createCatalogService(app.db);
  mount(app, routes.savePrice, async (req) => svc.savePrice(req.params.list, req.params.it, req.body.price));
  mount(app, routes.addMenuItem, async (req) => svc.addMenuItem(req.params.loc, req.body.it));
  mount(app, routes.removeMenuItem, async (req) => svc.removeMenuItem(req.params.loc, req.params.it));
}, { name: "module:catalog", dependencies: ["auth", "rbac", "idempotency", "db"] });
