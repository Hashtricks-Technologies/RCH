import { describe, expect, it } from "vitest";
import { buildTestApp } from "../test/app.js";
import { NotReadyError, RateLimitedError, RuleError, UnauthenticatedError } from "../lib/errors.js";

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
      error: { code: "rate_limited", message: "Too many requests - wait a moment and try again." },
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
      error: { code: "rate_limited", message: "Too many requests - wait a moment and try again." },
    });

    await app.close();
  });

  it("maps an overload-shaped 503 (as @fastify/under-pressure throws) to not_ready", async () => {
    const app = await buildTestApp({ withDb: false });
    app.get("/__test/throws-overloaded", { config: { rateLimit: false } }, async () => {
      const err = new Error("The service is overloaded - try again shortly.");
      (err as { statusCode?: number }).statusCode = 503;
      throw err;
    });
    await app.ready();

    const r = await app.inject({ method: "GET", url: "/__test/throws-overloaded" });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({
      error: { code: "not_ready", message: "The service is overloaded - try again shortly." },
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
      const err = new Error("The service is overloaded - try again shortly.");
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

describe("what a refused request leaves in the log", () => {
  /** A pino stream the test can read back: one parsed line per record. */
  const capture = () => {
    const lines: Array<Record<string, unknown>> = [];
    return { lines, write: (s: string) => { for (const l of s.split("\n")) if (l) lines.push(JSON.parse(l) as Record<string, unknown>); } };
  };

  it("carries the error code, the sentence, and the internal cause on the request's own line - and the cause never reaches the wire", async () => {
    const log = capture();
    const app = await buildTestApp({ withDb: false, env: { LOG_LEVEL: "info" }, logStream: log });
    app.get("/__test/refuses", { config: { rateLimit: false } }, async () => {
      throw new UnauthenticatedError("That employee id and password do not match.", "wrong password for RC-4471");
    });
    await app.ready();

    const r = await app.inject({ method: "GET", url: "/__test/refuses" });
    expect(r.statusCode).toBe(401);
    // The operator's sentence and nothing else: the cause is for the log, never the browser.
    expect(r.json()).toEqual({ error: { code: "unauthenticated", message: "That employee id and password do not match." } });

    // One line per request, and a refused one says why - an operator asking "why can't RC-4471
    // sign in" reads it here rather than guessing between no such account, a wrong password and
    // a deactivated one.
    const line = log.lines.find((l) => l.msg === "request" && l.route === "/__test/refuses");
    expect(line).toMatchObject({
      status: 401,
      refusal: { code: "unauthenticated", message: "That employee id and password do not match.", cause: "wrong password for RC-4471" },
    });

    await app.close();
  });

  it("names the code and the sentence for a rule refusal with no cause, and nothing for a request that succeeded", async () => {
    const log = capture();
    const app = await buildTestApp({ withDb: false, env: { LOG_LEVEL: "info" }, logStream: log });
    app.get("/__test/rule", { config: { rateLimit: false } }, async () => { throw new RuleError("Only 3 cups on the shelf."); });
    app.get("/__test/fine", { config: { rateLimit: false } }, async () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: "GET", url: "/__test/rule" });
    await app.inject({ method: "GET", url: "/__test/fine" });
    const rule = log.lines.find((l) => l.msg === "request" && l.route === "/__test/rule");
    expect(rule).toMatchObject({ status: 422, refusal: { code: "rule", message: "Only 3 cups on the shelf." } });
    expect((rule!.refusal as Record<string, unknown>).cause).toBeUndefined();
    const fine = log.lines.find((l) => l.msg === "request" && l.route === "/__test/fine");
    expect(fine).toMatchObject({ status: 200 });
    expect(fine).not.toHaveProperty("refusal");

    await app.close();
  });

  it("logs a 5xx AppError's underlying cause in full, not just the caller's sentence", async () => {
    const log = capture();
    const app = await buildTestApp({ withDb: false, env: { LOG_LEVEL: "info" }, logStream: log });
    app.get("/__test/not-ready", { config: { rateLimit: false } }, async () => {
      throw new NotReadyError("The photo could not be stored just now - try again", new Error("s3 down"));
    });
    await app.ready();

    const r = await app.inject({ method: "GET", url: "/__test/not-ready" });
    expect(r.statusCode).toBe(503);
    // The caller reads only the operator's sentence, same as any other refusal.
    expect(r.json()).toEqual({ error: { code: "not_ready", message: "The photo could not be stored just now - try again" } });

    const line = log.lines.find((l) => l.msg === "service refused as not ready");
    // pino's `err` serializer recurses into `.internal` since it's an enumerable own property.
    expect((line!.err as { internal?: { message?: string } }).internal?.message).toBe("s3 down");

    await app.close();
  });
});
