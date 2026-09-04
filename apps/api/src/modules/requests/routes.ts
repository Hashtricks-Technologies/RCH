// Requests: what an outlet asks the central store for — raised, decided, and turned into a ticket.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createRequestsService } from "./service.js";

export default fp(async (app) => {
  const svc = createRequestsService(app.db);
  // The raiser's location is the token's, never the body's — there is nothing to scope here.
  mount(app, routes.createRequest, async (req) => svc.create(req.user, req.body));
  // The rest scope on the document's own location, which only the service has read, so the
  // 403 lives there (requireLocOf) rather than in this file.
  mount(app, routes.cancelRequest, async (req) => svc.cancel(req.user, req.params.id));
  mount(app, routes.approveRequest, async (req) => svc.approve(req.user, req.params.id, req.body));
  mount(app, routes.rejectRequest, async (req) => svc.reject(req.user, req.params.id, req.body));
  mount(app, routes.issueTicket, async (req) => svc.issue(req.user, req.params.id));
}, { name: "module:requests", dependencies: ["auth", "rbac", "idempotency", "db"] });
