import fp from "fastify-plugin";
import { createVendorsService } from "./service.js";

// The buyer's vendor roster. No route is mounted yet — the manifest entries exist (they are
// inert without a handler) and the endpoints land with their tests in this module's own task.
export default fp(async (app) => {
  createVendorsService(app.db);
}, { name: "module:vendors", dependencies: ["auth", "rbac", "idempotency", "db"] });
