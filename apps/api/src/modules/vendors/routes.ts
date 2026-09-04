import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createVendorsService } from "./service.js";

// The buyer's own master. One PATCH covers both the edit and the on/off switch, because
// `setVendorActive` was only ever a patch of one field.
export default fp(async (app) => {
  const svc = createVendorsService(app.db);
  mount(app, routes.addVendor, async (req) => svc.create(req.user, req.body));
  mount(app, routes.updateVendor, async (req) => svc.patch(req.user, req.params.id, req.body));
}, { name: "module:vendors", dependencies: ["auth", "rbac", "idempotency", "db"] });
