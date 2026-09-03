import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp } from "../test/app.js";
import { seedTestDb } from "../test/seed.js";
import { authHeaders } from "../test/auth.js";
import type { App } from "../app.js";

/** A budget small enough to exhaust in a test, and a route that needs a token. */
let app: App;
beforeAll(async () => {
  app = await buildTestApp({ schema: "security", env: { RATE_LIMIT_PER_MINUTE: "10" } });
  await seedTestDb(app.testDb!.db);
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe("the global rate limit", () => {
  it("gives two signed-in users behind one IP a budget each", async () => {
    const u1 = await authHeaders(app, "u1");
    const u2 = await authHeaders(app, "u2");
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: "GET", url: "/api/v1/me", headers: u1 });
      expect(r.statusCode, `call ${i + 1} as u1`).toBe(200);
    }
    // Same IP (inject always says 127.0.0.1), different token: keyed on `sub`, so u2 arrives
    // with a full budget rather than sharing u1's exhausted one.
    expect((await app.inject({ method: "GET", url: "/api/v1/me", headers: u2 })).statusCode).toBe(200);
    // u1 is spent, though - the limit still bites, it is just per person.
    const over = await app.inject({ method: "GET", url: "/api/v1/me", headers: u1 });
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe("rate_limited");
  });
});

describe("server timeouts", () => {
  it("bounds a request well inside the idempotency claim's stale window", () => {
    // See app.ts and plugins/idempotency.ts's CLAIM_STALE_MS: a retry must not be able to take
    // over a claim still held by a legitimately slow, still-running request.
    //
    // `requestTimeout` is a real, validated Fastify constructor option (fastify's own test
    // suite asserts it round-trips through `initialConfig`) but this Fastify version's
    // `initialConfig` type omits it - a gap in @fastify/fastify's types, not a typo here.
    expect((app.initialConfig as { requestTimeout?: number }).requestTimeout).toBe(30_000);
    expect(app.initialConfig.connectionTimeout).toBe(10_000);
  });
});
