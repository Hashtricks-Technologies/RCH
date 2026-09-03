import fp from "fastify-plugin";
import { NotReadyError } from "../lib/errors.js";

type Check = () => Promise<void>;
declare module "fastify" {
  interface FastifyInstance {
    readiness: { addCheck(name: string, check: Check): void; setDraining(): void };
  }
}

/** /healthz says the process is up. /readyz says it may receive traffic: every registered
 *  check passes and we are not draining. Task 5 registers the database check. */
export default fp(async (app) => {
  const checks = new Map<string, Check>();
  let draining = false;
  app.decorate("readiness", {
    addCheck: (name: string, check: Check) => { checks.set(name, check); },
    setDraining: () => { draining = true; },
  });
  app.get("/healthz", { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get("/readyz", { config: { rateLimit: false } }, async (_req, reply) => {
    if (draining) { reply.code(503); return new NotReadyError("Shutting down.").toEnvelope(); }
    if (checks.size === 0) { reply.code(503); return new NotReadyError("No readiness checks registered.").toEnvelope(); }
    const failed: string[] = [];
    for (const [name, check] of checks) { try { await check(); } catch { failed.push(name); } }
    if (failed.length) { reply.code(503); return new NotReadyError(`Not ready: ${failed.join(", ")}.`).toEnvelope(); }
    return { ok: true };
  });
}, { name: "health" });
