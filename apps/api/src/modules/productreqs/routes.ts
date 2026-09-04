// The shop's new-product ask, and the central store's answer to it.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createProductReqsService } from "./service.js";

export default fp(async (app) => {
  const svc = createProductReqsService(app.db);
  mount(app, routes.createProductRequest, async (req) => svc.create(req.user, req.body));
  mount(app, routes.answerProductRequest, async (req) => svc.answer(req.params.id, req.body));
}, { name: "module:productreqs", dependencies: ["auth", "rbac", "idempotency", "db"] });
