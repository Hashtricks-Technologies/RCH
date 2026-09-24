// The shop's new-product ask, and the central store's answer to it.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { createProductReqsService } from "./service.js";

export default fp(async (app) => {
  const svc = createProductReqsService(app.db);
  mount(app, routes.createProductRequest, async (req) => {
    // A till asks for its own outlet and no other: the token decides, not the body, the same
    // way `pos` decides which counter a bill belongs to. A role that works hospital-wide (Menus,
    // or every outlet) reaches every outlet, so there the body decides and the service checks it
    // names an outlet at all.
    if (!req.actor.wide) requireLoc(req, req.body.forLoc, "your own counter");
    return svc.create(req.actor, req.body);
  });
  mount(app, routes.answerProductRequest, async (req) => svc.answer(req.user, req.params.id, req.body));
}, { name: "module:productreqs", dependencies: ["auth", "rbac", "idempotency", "db"] });
