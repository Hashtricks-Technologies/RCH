// Roles & permissions: the super admin's. Every route is `access: "admin"` in the manifest.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createRolesService } from "./service.js";

export default fp(async (app) => {
  const svc = createRolesService(app.db, () => app.access.clear());
  mount(app, routes.adminRoles, async () => svc.list());
  mount(app, routes.createRole, async (req) => svc.create(req.user, req.body));
  mount(app, routes.updateRole, async (req) => svc.update(req.user, req.params.id, req.body));
  mount(app, routes.deactivateRole, async (req) => svc.deactivate(req.user, req.params.id));
  mount(app, routes.reactivateRole, async (req) => svc.reactivate(req.user, req.params.id));
  mount(app, routes.deleteRole, async (req) => svc.remove(req.user, req.params.id));
}, { name: "module:roles", dependencies: ["auth", "rbac", "idempotency", "db", "access"] });
