import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createPricelistsService } from "./service.js";

// The manager's price-list management screen. `GET /price-lists` is mounted with `prices` in
// `modules/master` - this module owns the three writes: create (cloned from an outlet), delete
// (only once unattached) and switching which list an outlet is active on.
export default fp(async (app) => {
  const svc = createPricelistsService(app.db);
  mount(app, routes.createPriceList, async (req) => svc.create(req.user, req.body));
  mount(app, routes.deletePriceList, async (req) => svc.remove(req.user, req.params.id));
  mount(app, routes.setOutletPriceList, async (req) => svc.activate(req.user, req.params.loc, req.body.listId));
  // The manager's counter price grid: prices and on/off across outlets, one batch, one transaction.
  mount(app, routes.saveOutletPrices, async (req) => svc.saveOutletPrices(req.user, req.body));
}, { name: "module:pricelists", dependencies: ["auth", "rbac", "idempotency", "db"] });
