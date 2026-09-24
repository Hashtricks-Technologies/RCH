// Admin: account management, outlets and the payer register. Every route here checks the `admin` claim
// (`access: "admin"` in the manifest), never a role; that gate lives in `roleGate`
// itself rather than a bespoke check per handler.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createAdminService } from "./service.js";

export default fp(async (app) => {
  const svc = createAdminService(app.db, () => app.access.clear());
  mount(app, routes.adminUsers, async () => svc.list());
  mount(app, routes.createAdminUser, async (req) => svc.create(req.user, req.body));
  mount(app, routes.resetAdminUserPassword, async (req) => svc.resetPassword(req.user, req.params.id));
  mount(app, routes.deactivateAdminUser, async (req) => svc.deactivate(req.user, req.params.id));
  mount(app, routes.reactivateAdminUser, async (req) => svc.reactivate(req.user, req.params.id));
  mount(app, routes.updateAdminUser, async (req) => svc.updateRoleLoc(req.user, req.params.id, req.body));
  // ---- postings: which counters this account may work. Its own route, because it is its own
  // decision - and because it revokes every session the account holds, which a role move does not.
  mount(app, routes.setAdminUserPostings, async (req) => svc.setPostings(req.user, req.params.id, req.body.locs));
  // `svc.setPostings` has no route yet, and cannot have one from here: the manifest carries no
  // entry for it and `UpdateAdminUserBodySchema` is strict, so a `postings` key on the patch above
  // is a 400 before any handler sees it. The service and the rule behind it are written and
  // tested; mounting them is one `defineRoute` in packages/contract away.
  mount(app, routes.deleteAdminUser, async (req) => svc.remove(req.user, req.params.id));
  mount(app, routes.adminActions, async (req) => svc.actions(req.query.kind));
  mount(app, routes.adminLocations, async () => svc.locations());
  mount(app, routes.createOutlet, async (req) => svc.openOutlet(req.user, req.body));
  mount(app, routes.updateOutlet, async (req) => svc.updateOutlet(req.user, req.params.key, req.body));
  mount(app, routes.closeOutlet, async (req) => svc.closeOutlet(req.user, req.params.key));
  mount(app, routes.reopenOutlet, async (req) => svc.reopenOutlet(req.user, req.params.key));
  // ---- the payer register: who a bill may be posted to. Never deleted, only switched off.
  mount(app, routes.adminPayers, async () => svc.payers());
  mount(app, routes.createPayer, async (req) => svc.createPayer(req.user, req.body));
  mount(app, routes.updatePayer, async (req) => svc.updatePayer(req.user, req.params.kind, req.params.id, req.body));
}, { name: "module:admin", dependencies: ["auth", "rbac", "idempotency", "db", "access"] });
