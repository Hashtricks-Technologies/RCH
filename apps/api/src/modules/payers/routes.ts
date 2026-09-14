import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createPayersService } from "./service.js";

// The register behind every non-cash tender. The outlet manager keeps it - they are the role
// that settles a credit account - and one PATCH covers both the edit and the on/off switch,
// because closing an account was only ever a patch of one field.
//
// Two reads answer for this table, and the split is the point. `GET /roster` is not here: it
// answers with the slice the snapshot already carries - live payers only, because a closed
// account must never reach a till's payer picker - and is mounted beside its siblings in
// `modules/snapshot/routes.ts` under the same `scopeRoster`. `GET /payers` is here and is the
// register whole, closed rows included, for the one role that can reopen one.
export default fp(async (app) => {
  const svc = createPayersService(app.db);
  mount(app, routes.addPayer, async (req) => svc.create(req.user, req.body));
  mount(app, routes.updatePayer, async (req) => svc.patch(req.user, req.params.kind, req.params.id, req.body));
  mount(app, routes.payers, async (req) => svc.list(req.user));
}, { name: "module:payers", dependencies: ["auth", "rbac", "idempotency", "db"] });
