import fp from "fastify-plugin";
import { createPurchaseOrdersService } from "./service.js";

// The buyer's order. No route is mounted yet — the manifest entries exist (they are inert
// without a handler) and the endpoints land with their tests in this module's own task.
export default fp(async (app) => {
  createPurchaseOrdersService(app.db);
}, { name: "module:purchaseorders", dependencies: ["auth", "rbac", "idempotency", "db"] });
