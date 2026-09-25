// Wastage: parse, scope, service, reply. A record is always the kitchen's: the caller is held to
// the kitchen by `requireLoc`, the way every other kitchen write is - so a store keeper, who holds
// Adjustments too, is answered with the ordinary wrong-location refusal.
import fp from "fastify-plugin";
import { KITCHEN, routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { createWastageService } from "./service.js";

export default fp(async (app) => {
  const svc = createWastageService(app.db);
  mount(app, routes.createWastage, async (req) => {
    requireLoc(req, KITCHEN, "the Central Kitchen");
    return svc.create(req.user, req.body);
  });
  mount(app, routes.kitchenReport, async (req) => svc.report(req.query));
}, { name: "module:wastage", dependencies: ["auth", "rbac", "idempotency", "db"] });
