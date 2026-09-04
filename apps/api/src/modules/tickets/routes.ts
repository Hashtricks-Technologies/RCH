// Issue, handover and receipt — the two scans that actually move stock.
//
// Wired but empty: the module is registered from the moment it lands so the four wave-3 tasks
// can each fill one in without four of them editing modules/index.ts. It mounts nothing yet —
// the module task adds the mount() calls.
import fp from "fastify-plugin";
import { createTicketsService } from "./service.js";

export default fp(async (app) => {
  const svc = createTicketsService(app.db);
  await svc.ready();
}, { name: "module:tickets", dependencies: ["auth", "rbac", "idempotency", "db"] });
