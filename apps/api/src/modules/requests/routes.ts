// The counter and kitchen's stock requests, and the manager's decision on them.
//
// Wired but empty: the module is registered from the moment it lands so the four wave-3 tasks
// can each fill one in without four of them editing modules/index.ts. It mounts nothing yet —
// the module task adds the mount() calls.
import fp from "fastify-plugin";
import { createRequestsService } from "./service.js";

export default fp(async (app) => {
  const svc = createRequestsService(app.db);
  await svc.ready();
}, { name: "module:requests", dependencies: ["auth", "rbac", "idempotency", "db"] });
