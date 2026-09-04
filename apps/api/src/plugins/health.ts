import fp from "fastify-plugin";
import { NotReadyError } from "../lib/errors.js";

type Check = () => Promise<void>;
declare module "fastify" {
  interface FastifyInstance {
    readiness: { addCheck(name: string, check: Check): void; setDraining(): void };
  }
}

/**
 * /healthz says the process is up. /readyz says it may receive traffic: every registered
 * check passes and we are not draining. `plugins/db.ts` registers the database check.
 *
 * **A check's `Error` message is operator-facing.** It is appended to the 503's own sentence
 * (`Not ready: database — schema at 0/7 migrations.`) and logged whole, so a check writes a
 * phrase a person reads off a stuck rollout and never the driver's own message — spec §12 keeps
 * SQL and stack traces out of responses, and `plugins/db.ts` is where that curation happens for
 * the one check that exists. Without the reason, "Not ready: database." cannot tell a schema
 * behind from a database unreachable, which are the two states an operator has to act on
 * differently.
 */
export default fp(async (app) => {
  const checks = new Map<string, Check>();
  let draining = false;
  app.decorate("readiness", {
    addCheck: (name: string, check: Check) => { checks.set(name, check); },
    setDraining: () => { draining = true; },
  });
  app.get("/healthz", { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get("/readyz", { config: { rateLimit: false } }, async (req, reply) => {
    if (draining) { reply.code(503); return new NotReadyError("Shutting down.").toEnvelope(); }
    if (checks.size === 0) { reply.code(503); return new NotReadyError("No readiness checks registered.").toEnvelope(); }
    const failed: string[] = [];
    for (const [name, check] of checks) {
      try { await check(); } catch (err) {
        // The reason is the whole diagnostic value of this 503. Logged with the error itself
        // (cause and stack included, which the body never carries) and carried into the sentence.
        req.log.warn({ err, check: name }, "readiness check failed");
        const why = err instanceof Error ? err.message.trim() : "";
        failed.push(why ? `${name} — ${why}` : name);
      }
    }
    if (failed.length) { reply.code(503); return new NotReadyError(`Not ready: ${failed.join(", ")}.`).toEnvelope(); }
    return { ok: true };
  });
}, { name: "health" });
