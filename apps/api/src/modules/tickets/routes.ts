// Tickets: the scan that moves stock - handover at the window, receipt on the shelf - and the
// shop-to-shop transfer that raises one without a request behind it.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { requireLoc } from "../../plugins/rbac.js";
import { createTicketsService } from "./service.js";

export default fp(async (app) => {
  const svc = createTicketsService(app.db);
  // Both of these scope on the ticket's own from/to, which only the service has read.
  mount(app, routes.handover, async (req) => svc.handover(req.user, req.params.id, req.body));
  mount(app, routes.receiveTicket, async (req) => svc.receive(req.user, req.params.id));
  // Scoped by the ticket's own `from`, in the service: the store cancels what the store issued
  // and the kitchen what the kitchen dispatched.
  mount(app, routes.cancelTicket, async (req) => svc.cancel(req.user, req.params.id, req.body));
  // A transfer names its own source, so the scope is checkable here: a role that moves stock
  // hospital-wide (Items & stock, or every outlet) may move it between any two outlets, as it may
  // switch any outlet's products off; one on its own counter's pick tickets moves only its own.
  mount(app, routes.transfer, async (req) => {
    if (!req.actor.wide) requireLoc(req, req.body.from, "your own counter");
    return svc.transfer(req.user, req.body);
  });
}, { name: "module:tickets", dependencies: ["auth", "rbac", "idempotency", "db"] });
