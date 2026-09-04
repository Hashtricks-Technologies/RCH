// Support: customer care for the portal itself. Every role, own tickets only.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createSupportService } from "./service.js";

export default fp(async (app) => {
  const svc = createSupportService(app.db);
  mount(app, routes.tickets, async (req) => svc.list(req.user));
}, { name: "module:support", dependencies: ["auth", "rbac", "idempotency", "db"] });
