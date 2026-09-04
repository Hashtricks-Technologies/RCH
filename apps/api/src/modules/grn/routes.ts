import fp from "fastify-plugin";
import { createGrnService } from "./service.js";

// The store keeper's delivery. No route is mounted yet — the manifest entries exist (they are
// inert without a handler) and the endpoints land with their tests in this module's own task.
export default fp(async (app) => {
  createGrnService(app.db);
}, { name: "module:grn", dependencies: ["auth", "rbac", "idempotency", "db"] });
