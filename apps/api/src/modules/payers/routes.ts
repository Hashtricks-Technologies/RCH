import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createPayersService } from "./service.js";

// The register behind every non-cash tender. The outlet manager keeps it — they are the role
// that settles a credit account — and one PATCH covers both the edit and the on/off switch,
// because closing an account was only ever a patch of one field. `GET /roster` is not here: it
// answers with a slice the snapshot already carries and is mounted beside its siblings in
// `modules/snapshot/routes.ts`, scoped by the same `scopeRoster`.
export default fp(async (app) => {
  const svc = createPayersService(app.db);
  mount(app, routes.addPayer, async (req) => svc.create(req.user, req.body));
  mount(app, routes.updatePayer, async (req) => svc.patch(req.user, req.params.kind, req.params.id, req.body));
}, { name: "module:payers", dependencies: ["auth", "rbac", "idempotency", "db"] });
