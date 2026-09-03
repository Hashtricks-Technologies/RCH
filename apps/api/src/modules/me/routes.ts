import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createMeService } from "./service.js";

export default fp(async (app) => {
  const svc = createMeService(app.db);
  mount(app, routes.me, async (req) => svc.get(req.user.sub));
  mount(app, routes.patchMe, async (req) => svc.patch(req.user.sub, req.body));
}, { name: "module:me", dependencies: ["auth", "rbac", "idempotency", "db"] });
