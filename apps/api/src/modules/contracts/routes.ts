import fp from "fastify-plugin";
import { createContractsService } from "./service.js";

// The buyer's rate contract. No route is mounted yet — the manifest entries exist (they are
// inert without a handler) and the endpoints land with their tests in this module's own task.
export default fp(async (app) => {
  createContractsService(app.db);
}, { name: "module:contracts", dependencies: ["auth", "rbac", "idempotency", "db"] });
