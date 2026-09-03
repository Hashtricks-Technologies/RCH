import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createMasterService } from "./service.js";
export default fp(async (app) => {
  const svc = createMasterService(app.db);
  mount(app, routes.items, async () => svc.items());
  mount(app, routes.locations, async () => svc.locations());
  mount(app, routes.recipes, async () => svc.recipes());
  mount(app, routes.prices, async () => svc.prices());
  mount(app, routes.menus, async () => svc.menus());
}, { name: "module:master", dependencies: ["auth", "rbac", "db"] });
