import fp from "fastify-plugin";
import { createRequisitionsService } from "./service.js";

// The store keeper's ask. No route is mounted yet — the manifest entries exist (they are inert
// without a handler) and the endpoints land with their tests in this module's own task.
export default fp(async (app) => {
  createRequisitionsService(app.db);
}, { name: "module:requisitions", dependencies: ["auth", "rbac", "idempotency", "db"] });
