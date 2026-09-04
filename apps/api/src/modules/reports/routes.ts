// Reports: the two figures the browser cannot compute from its own snapshot — the central store's
// stock ledger, which needs the ledger's own moves, and a payer's credit for the calendar month,
// which needs every outlet's bills and not the till's own seven days.
//
// routes.ts: parse -> service -> reply, nothing else. Who may ask is the manifest's `access`
// list, not a check written here: the ledger is the four roles that hold or order stock, and
// the credit report is the counter that takes the charge and the manager who answers for it.
import fp from "fastify-plugin";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { createReportsService } from "./service.js";

export default fp(async (app) => {
  const svc = createReportsService(app.db);
  mount(app, routes.stockLedger, async (req) => svc.stockLedger(req.query));
  mount(app, routes.creditReport, async (req) => svc.credit(req.params));
}, { name: "module:reports", dependencies: ["auth", "rbac", "idempotency", "db"] });
