// Shop asks: one shop asking another for stock it is holding. The manager sees it; it never
// routes through them.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createShopAsksService } from "./service.js";

export default fp(async (app) => {
  const svc = createShopAsksService(app.db);
  mount(app, routes.askShop, async (req) => svc.ask(req.user, req.body));
  mount(app, routes.answerShopAsk, async (req) => svc.answer(req.user, req.params.id, req.body));
  mount(app, routes.declineShopAsk, async (req) => svc.decline(req.user, req.params.id, req.body));
}, { name: "module:shopasks", dependencies: ["auth", "rbac", "idempotency", "db"] });
