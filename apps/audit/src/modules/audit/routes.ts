// routes.ts: parse, call the service, reply. The admin gate is attached by `mount()`.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createAuditService } from "./service.js";

export default fp(async (app) => {
  const svc = createAuditService(app.db);
  mount(app, routes.auditLog, async (req) => svc.list(req.query));
  mount(app, routes.auditEntry, async (req) => svc.entry(req.params.id));
}, { name: "module:audit", dependencies: ["auth", "db"] });
