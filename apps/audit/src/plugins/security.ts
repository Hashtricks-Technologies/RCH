import fp from "fastify-plugin";
import helmet from "@fastify/helmet";

/** Security headers. The service answers JSON to one origin (the UI's proxy sends
 *  `/api/v1/admin/audit` here), so there is no CORS to configure, and CSP belongs to the UI's
 *  nginx. Every route but the probes and /metrics needs an admin token (plugins/auth.ts). */
export default fp(async (app) => {
  await app.register(helmet, { contentSecurityPolicy: false });
}, { name: "security" });
