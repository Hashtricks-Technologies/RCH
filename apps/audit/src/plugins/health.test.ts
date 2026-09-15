import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import errors from "./errors.js";
import health from "./health.js";

/** The health plugin alone: what /readyz says is decided by the checks, whoever registers them. */
let app: FastifyInstance | undefined;
async function bare(): Promise<FastifyInstance> {
  app = Fastify();
  await app.register(errors);
  await app.register(health);
  return app;
}
afterEach(async () => { await app?.close(); app = undefined; });

describe("GET /readyz", () => {
  it("is not ready while nothing has registered a check", async () => {
    const a = await bare();
    const r = await a.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: { code: "not_ready", message: "No readiness checks registered." } });
  });

  it("is ready when every check passes, whether it returns nothing or true", async () => {
    const a = await bare();
    a.readiness.addCheck("database", async () => {});
    a.readiness.addCheck("drainer", async () => true);
    const r = await a.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("names every failing check, with its reason when it gives one", async () => {
    const a = await bare();
    a.readiness.addCheck("database", async () => { throw new Error("schema at 0/1 migrations"); });
    a.readiness.addCheck("drainer", async () => { throw new Error(""); });
    a.readiness.addCheck("listener", () => false);
    a.readiness.addCheck("cache", () => true);
    const r = await a.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: { code: "not_ready", message: "Not ready: database - schema at 0/1 migrations, drainer, listener." } });
  });

  it("answers 503 once draining, while /healthz stays 200", async () => {
    const a = await bare();
    a.readiness.addCheck("database", async () => {});
    a.readiness.setDraining();
    const r = await a.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: { code: "not_ready", message: "Shutting down." } });
    expect((await a.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});
