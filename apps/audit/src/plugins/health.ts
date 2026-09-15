import fp from "fastify-plugin";
import { NotReadyError } from "../lib/errors.js";

/** A check passes by returning (nothing, or `true`) and fails by returning `false` - reported by
 *  name alone - or by throwing, whose message is reported after the name. */
type Check = () => Promise<boolean | void> | boolean | void;
declare module "fastify" {
  interface FastifyInstance {
    readiness: { addCheck(name: string, check: Check): void; setDraining(): void };
  }
}

/**
 * /healthz says the process is up. /readyz says it may receive traffic: every registered check
 * passes and the process is not draining. `plugins/db.ts` registers the database check and
 * `plugins/drainer.ts` the drain check; anything else that gates readiness calls `addCheck`.
 *
 * **A thrown check's `Error` message is operator-facing.** It is appended to the 503's sentence
 * (`Not ready: database - schema at 0/1 migrations.`) and logged whole, so a check throws a
 * phrase a person can act on, never the driver's own message.
 */
export default fp(async (app) => {
  const checks = new Map<string, Check>();
  let draining = false;
  app.decorate("readiness", {
    addCheck: (name: string, check: Check) => { checks.set(name, check); },
    setDraining: () => { draining = true; },
  });
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (req, reply) => {
    if (draining) { reply.code(503); return new NotReadyError("Shutting down.").toEnvelope(); }
    if (checks.size === 0) { reply.code(503); return new NotReadyError("No readiness checks registered.").toEnvelope(); }
    const failed: string[] = [];
    for (const [name, check] of checks) {
      try {
        if ((await check()) === false) failed.push(name);
      } catch (err) {
        req.log.warn({ err, check: name }, "readiness check failed");
        const why = err instanceof Error ? err.message.trim() : "";
        failed.push(why ? `${name} - ${why}` : name);
      }
    }
    if (failed.length) { reply.code(503); return new NotReadyError(`Not ready: ${failed.join(", ")}.`).toEnvelope(); }
    return { ok: true };
  });
}, { name: "health" });
