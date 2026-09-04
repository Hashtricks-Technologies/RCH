import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createContractsService } from "./service.js";

// The store keeper records what each vendor has agreed to; the buyer's drafts are priced off
// it. A delete is soft: history has to stay readable.
export default fp(async (app) => {
  const svc = createContractsService(app.db);
  mount(app, routes.addContract, async (req) => svc.create(req.user, req.body));
  mount(app, routes.updateContract, async (req) => svc.patch(req.user, req.params.id, req.body));
  mount(app, routes.removeContract, async (req) => svc.remove(req.user, req.params.id));
}, { name: "module:contracts", dependencies: ["auth", "rbac", "idempotency", "db"] });
