import { describe, expect, it } from "vitest";
import { buildTestApp } from "../test/app.js";
import { RateLimitedError } from "../lib/errors.js";

describe("rate limiting", () => {
  it("answers the 11th request in a 10/minute window with the rate_limited envelope", async () => {
    const app = await buildTestApp({ withDb: false, env: { RATE_LIMIT_PER_MINUTE: "10" } });
    // /healthz, /readyz and /metrics all opt out of the global limiter (`config: { rateLimit: false }`),
    // so exercise it with a route that doesn't.
    app.get("/__test/limited", async () => ({ ok: true }));
    await app.ready();

    let last;
    for (let i = 0; i < 11; i++) {
      last = await app.inject({ method: "GET", url: "/__test/limited" });
    }

    expect(last!.statusCode).toBe(429);
    expect(last!.json()).toEqual({
      error: { code: "rate_limited", message: "Too many requests — wait a moment and try again." },
    });
    expect(last!.headers["x-request-id"]).toBeDefined();

    await app.close();
  });
});

describe("error envelope mapping", () => {
  it("maps a thrown RateLimitedError to 429 with the exact envelope", async () => {
    const app = await buildTestApp({ withDb: false });
    app.get("/__test/throws-rate-limited", { config: { rateLimit: false } }, async () => {
      throw new RateLimitedError();
    });
    await app.ready();

    const r = await app.inject({ method: "GET", url: "/__test/throws-rate-limited" });
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({
      error: { code: "rate_limited", message: "Too many requests — wait a moment and try again." },
    });

    await app.close();
  });

  it("maps an overload-shaped 503 (as @fastify/under-pressure throws) to not_ready", async () => {
    const app = await buildTestApp({ withDb: false });
    app.get("/__test/throws-overloaded", { config: { rateLimit: false } }, async () => {
      const err = new Error("The service is overloaded — try again shortly.");
      (err as { statusCode?: number }).statusCode = 503;
      throw err;
    });
    await app.ready();

    const r = await app.inject({ method: "GET", url: "/__test/throws-overloaded" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({
      error: { code: "not_ready", message: "The service is overloaded — try again shortly." },
    });

    await app.close();
  });

  it("maps a 401-shaped error to the fixed unauthenticated message, without leaking the original one", async () => {
    const app = await buildTestApp({ withDb: false });
    app.get("/__test/throws-unauthenticated", { config: { rateLimit: false } }, async () => {
      const err = new Error("jwt malformed");
      (err as { statusCode?: number }).statusCode = 401;
      throw err;
    });
    await app.ready();

    const r = await app.inject({ method: "GET", url: "/__test/throws-unauthenticated" });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in to continue." } });

    await app.close();
  });

  it("never leaks a stack trace or the raw statusCode field into the envelope body", async () => {
    const app = await buildTestApp({ withDb: false });
    app.get("/__test/throws-rate-limited", { config: { rateLimit: false } }, async () => {
      throw new RateLimitedError();
    });
    app.get("/__test/throws-overloaded", { config: { rateLimit: false } }, async () => {
      const err = new Error("The service is overloaded — try again shortly.");
      (err as { statusCode?: number }).statusCode = 503;
      throw err;
    });
    app.get("/__test/throws-unauthenticated", { config: { rateLimit: false } }, async () => {
      const err = new Error("jwt malformed");
      (err as { statusCode?: number }).statusCode = 401;
      throw err;
    });
    await app.ready();

    for (const url of ["/__test/throws-rate-limited", "/__test/throws-overloaded", "/__test/throws-unauthenticated"]) {
      const r = await app.inject({ method: "GET", url });
      const body = r.json() as { error: Record<string, unknown> };
      expect(Object.keys(body)).toEqual(["error"]);
      expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
      expect(body.error).not.toHaveProperty("stack");
      expect(body.error).not.toHaveProperty("statusCode");
    }

    await app.close();
  });
});
