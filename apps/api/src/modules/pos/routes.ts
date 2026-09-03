// Pos: the counter sale — cart, pay, the bill.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { createPosService } from "./service.js";

export default fp(async (app) => {
  const svc = createPosService(app.db);
  // Role decides the route exists (mount attaches the gate); location decides the till. The
  // check stays here because it reads the request — the service is handed claims and a body.
  mount(app, routes.pay, async (req) => {
    requireLoc(req, req.body.loc, "your own counter");
    return svc.pay(req.user, req.body);
  });
}, { name: "module:pos", dependencies: ["auth", "rbac", "db"] });
