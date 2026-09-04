import fp from "fastify-plugin";
import { createProductReqsService } from "./service.js";

// The shop's new-product ask. No route is mounted yet — the manifest entries exist (they are
// inert without a handler) and the endpoints land with their tests in this module's own task.
export default fp(async (app) => {
  createProductReqsService(app.db);
}, { name: "module:productreqs", dependencies: ["auth", "rbac", "idempotency", "db"] });
