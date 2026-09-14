// Requests: what an outlet asks the central store for - raised, decided, and turned into a ticket.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createRequestsService } from "./service.js";

export default fp(async (app) => {
  const svc = createRequestsService(app.db);
  // The raiser's location is the token's, never the body's - there is nothing to scope here.
  mount(app, routes.createRequest, async (req) => svc.create(req.user, req.body));
  // A manager is hospital-wide - one manager supervises every outlet - so approve/reject take
  // no location; only cancel scopes, on the raiser's own outlet (requireLocOf, and only for
  // counter/prod - a manager withdrawing their own approval is hospital-wide too). Either way
  // the 403 lives in the service, which is the only place that has read the document's location.
  mount(app, routes.cancelRequest, async (req) => svc.cancel(req.user, req.params.id));
  mount(app, routes.approveRequest, async (req) => svc.approve(req.user, req.params.id, req.body));
  mount(app, routes.rejectRequest, async (req) => svc.reject(req.user, req.params.id, req.body));
  mount(app, routes.issueTicket, async (req) => svc.issue(req.user, req.params.id));
}, { name: "module:requests", dependencies: ["auth", "rbac", "idempotency", "db"] });
