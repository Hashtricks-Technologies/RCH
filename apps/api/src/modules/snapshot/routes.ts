import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createSnapshotService } from "./service.js";
export default fp(async (app) => {
  const svc = createSnapshotService(app.db);
  mount(app, routes.snapshot, async (req) => svc.snapshot(req.actor));
  // Reads of the same collections the snapshot carries, scoped the same way - so they live here.
  mount(app, routes.stock, async (req) => svc.stock(req.actor));
  mount(app, routes.bills, async (req) => svc.bills(req.actor, req.query.days));
  mount(app, routes.requests, async (req) => svc.requests(req.actor));
  mount(app, routes.ticketsList, async (req) => svc.tickets(req.actor));
  mount(app, routes.shopAsks, async (req) => svc.shopAsks(req.actor));
  mount(app, routes.prodOrders, async (req) => svc.prodOrders(req.actor));
  mount(app, routes.batches, async (req) => svc.batches(req.actor));
  // Buying's six, each answering for one slice a write can name in `changed`.
  mount(app, routes.requisitions, async (req) => svc.requisitions(req.actor));
  mount(app, routes.purchaseOrders, async (req) => svc.purchaseOrders(req.actor));
  mount(app, routes.grns, async (req) => svc.grns(req.actor));
  mount(app, routes.vendors, async (req) => svc.vendors(req.actor));
  mount(app, routes.contracts, async (req) => svc.contracts(req.actor));
  mount(app, routes.productRequests, async (req) => svc.productRequests(req.actor));
  // ---- payers ----
  mount(app, routes.roster, async (req) => svc.roster(req.actor));
  // ---- the rate card, scoped the same way the register it is about is. The writes that change
  // it are the outlet manager's and live in `modules/receivables`; this is the read every
  // browser refetches on a "terms" notice.
  mount(app, routes.payerTerms, async (req) => svc.terms(req.actor));
  // ---- adjustments: the register, scoped the same way the ledger it corrects is.
  mount(app, routes.adjustments, async (req) => svc.adjustments(req.actor));
  // ---- adjustment requests: a counter's asks, scoped the same way `requests` is.
  mount(app, routes.adjustmentRequests, async (req) => svc.adjustmentRequests(req.actor));
}, { name: "module:snapshot", dependencies: ["auth", "rbac", "db"] });
