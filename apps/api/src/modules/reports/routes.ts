// Reports: the two figures the browser cannot compute from its own snapshot — the central store's
// stock ledger, which needs `stock_moves`, and a staff member's credit for the calendar month,
// which needs every outlet's bills and not the till's own seven days. Task 6 fills this in; the
// module is registered empty so `modules/index.ts` is written once, in one wave, by one task.
//
// routes.ts: parse -> service -> reply, nothing else. This module mounts no route of its own
// yet — `GET /reports/stock-ledger` and its sibling are Task 6's — so it only builds the
// service to prove the wiring compiles and stays registered.
import fp from "fastify-plugin";
import { createReportsService } from "./service.js";

export default fp(async (app) => {
  createReportsService(app.db);
  app.log.debug({ module: "reports" }, "reports module built; empty until Task 6 fills it");
}, { name: "module:reports", dependencies: ["auth", "rbac", "idempotency", "db"] });
