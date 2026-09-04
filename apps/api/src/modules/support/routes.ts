// Support: customer care for the portal itself. Every role, own tickets only.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createSupportService } from "./service.js";

export default fp(async (app) => {
  const svc = createSupportService(app.db);
  mount(app, routes.tickets, async (req) => svc.list(req.user));
  // No `requireLoc` on any of the four: a support ticket has no location to scope on beyond the
  // one it records, and ownership is the scope. `mount` attaches the idempotency preHandler to
  // all four because they are non-GET and non-public.
  mount(app, routes.raiseTicket, async (req) => svc.raise(req.user, req.body));
  mount(app, routes.replyToTicket, async (req) => svc.reply(req.user, req.params.id, req.body));
  mount(app, routes.setTicketStatus, async (req) => svc.setStatus(req.user, req.params.id, req.body));
  mount(app, routes.rateTicket, async (req) => svc.rate(req.user, req.params.id, req.body));
}, { name: "module:support", dependencies: ["auth", "rbac", "idempotency", "db"] });
