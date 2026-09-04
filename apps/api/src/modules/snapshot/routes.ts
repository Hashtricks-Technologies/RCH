import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createSnapshotService } from "./service.js";
export default fp(async (app) => {
  const svc = createSnapshotService(app.db);
  mount(app, routes.snapshot, async (req) => svc.snapshot(req.user));
  // Reads of the same collections the snapshot carries, scoped the same way — so they live here.
  mount(app, routes.stock, async (req) => svc.stock(req.user));
  mount(app, routes.bills, async (req) => svc.bills(req.user, req.query.days));
  mount(app, routes.requests, async (req) => svc.requests(req.user));
  mount(app, routes.ticketsList, async (req) => svc.tickets(req.user));
  mount(app, routes.shopAsks, async (req) => svc.shopAsks(req.user));
  mount(app, routes.prodOrders, async (req) => svc.prodOrders(req.user));
  mount(app, routes.batches, async (req) => svc.batches(req.user));
  // Buying's six, each answering for one slice a write can name in `changed` (spec §9.1).
  mount(app, routes.requisitions, async (req) => svc.requisitions(req.user));
  mount(app, routes.purchaseOrders, async (req) => svc.purchaseOrders(req.user));
  mount(app, routes.grns, async (req) => svc.grns(req.user));
  mount(app, routes.vendors, async (req) => svc.vendors(req.user));
  mount(app, routes.contracts, async (req) => svc.contracts(req.user));
  mount(app, routes.productRequests, async (req) => svc.productRequests(req.user));
}, { name: "module:snapshot", dependencies: ["auth", "rbac", "db"] });
