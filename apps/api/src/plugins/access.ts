import fp from "fastify-plugin";
import { createAccessCache, loadAccess, type AccessCache } from "../lib/access.js";

declare module "fastify" { interface FastifyInstance { access: AccessCache } }

/**
 * `app.access`: what each account's role lets it do, read through a per-pod cache.
 *
 * Three things empty it, so a change the super admin makes takes effect on the next request
 * rather than the next sign-in: a `roles` notice on the change stream (`plugins/sse.ts`, from any
 * pod), a reconnect of that stream's LISTEN (notices may have been missed while it was down), and
 * the role and account writes themselves, locally, once they have committed - the notice reaches
 * this same pod too, but asynchronously, and the writer's own next request should not have to race
 * it. The 60 s TTL is only the backstop for a notice that never arrives.
 */
export default fp(async (app) => {
  app.decorate("access", createAccessCache((userId) => loadAccess(app.db, userId)));
}, { name: "access", dependencies: ["db"] });
