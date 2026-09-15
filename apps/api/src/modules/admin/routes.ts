// Admin: account management and outlets. Every route here checks the `admin` claim
// (`access: "admin"` in the manifest), never a role; that gate lives in `roleGate`
// itself rather than a bespoke check per handler.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createAdminService } from "./service.js";

export default fp(async (app) => {
  const svc = createAdminService(app.db);
  mount(app, routes.adminUsers, async () => svc.list());
  mount(app, routes.createAdminUser, async (req) => svc.create(req.user, req.body));
  mount(app, routes.resetAdminUserPassword, async (req) => svc.resetPassword(req.user, req.params.id));
  mount(app, routes.deactivateAdminUser, async (req) => svc.deactivate(req.user, req.params.id));
  mount(app, routes.reactivateAdminUser, async (req) => svc.reactivate(req.user, req.params.id));
  mount(app, routes.updateAdminUser, async (req) => svc.updateRoleLoc(req.user, req.params.id, req.body));
  mount(app, routes.deleteAdminUser, async (req) => svc.remove(req.user, req.params.id));
  mount(app, routes.adminActions, async (req) => svc.actions(req.query.kind));
  mount(app, routes.adminLocations, async () => svc.locations());
  mount(app, routes.createOutlet, async (req) => svc.openOutlet(req.user, req.body));
  mount(app, routes.updateOutlet, async (req) => svc.updateOutlet(req.user, req.params.key, req.body));
  mount(app, routes.closeOutlet, async (req) => svc.closeOutlet(req.user, req.params.key));
  mount(app, routes.reopenOutlet, async (req) => svc.reopenOutlet(req.user, req.params.key));
}, { name: "module:admin", dependencies: ["auth", "rbac", "idempotency", "db"] });
