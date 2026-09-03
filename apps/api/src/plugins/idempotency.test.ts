import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { defineRoute, OkResponseSchema } from "@rch/contract";
import { buildTestApp, testConfig } from "../test/app.js";
import { seedTestDb } from "../test/seed.js";
import { authHeaders } from "../test/auth.js";
import { buildApp, type App } from "../app.js";
import { mount } from "../routes.js";
import { purgeIdempotencyKeys } from "./idempotency.js";
import { idempotencyKeys } from "../db/schema/index.js";
import { meRepo } from "../modules/me/repo.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "idem" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

/** Promise.withResolvers, which the ES2023 lib this package targets does not declare yet. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Idempotency-Key", () => {
  it("is required on writes", async () => {
    const r = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: await authHeaders(app, "u1"), payload: { ph: "10000 00001" } });
    expect(r.statusCode).toBe(400); expect(r.json().error.message).toMatch(/Idempotency-Key/);
  });
  it("replays the stored response for the same key and body", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const a = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "11111 11111" } });
    const b = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "11111 11111" } });
    expect(b.statusCode).toBe(a.statusCode); expect(b.body).toBe(a.body); expect(b.headers["idempotency-replayed"]).toBe("true");
    expect(a.headers["idempotency-replayed"]).toBeUndefined();
  });
  it("a replay does not re-run the write", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const spy = vi.spyOn(meRepo, "update");
    const a = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "50000 00005" } });
    expect(a.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const b = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "50000 00005" } });
    expect(b.statusCode).toBe(200);
    expect(b.headers["idempotency-replayed"]).toBe("true");
    expect(spy).toHaveBeenCalledTimes(1); // still just once - the replay never reached the repo
    spy.mockRestore();
  });
  it("refuses the same key with a different body", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "22222 22222" } });
    const r = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "33333 33333" } });
    expect(r.statusCode).toBe(409); expect(r.json().error.code).toBe("conflict");
  });
  it("keys are per user", async () => {
    const key = randomUUID();
    const a = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...(await authHeaders(app, "u1")), "idempotency-key": key }, payload: { ph: "40000 00004" } });
    const b = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...(await authHeaders(app, "u2")), "idempotency-key": key }, payload: { ph: "40000 00004" } });
    expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200); expect(b.headers["idempotency-replayed"]).toBeUndefined();
  });
  it("lets exactly one of two concurrent requests with the same key through", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const send = () => app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "60000 00006" } });
    // Park the first request inside its own write so the second provably overlaps it. Racing
    // two injections and hoping is not a test - it passes or fails on the scheduler's mood.
    const entered = deferred(); const release = deferred();
    const real = meRepo.update;
    const parked: typeof meRepo.update = (tx, id, patch) => {
      entered.resolve();
      return release.promise.then(() => real(tx, id, patch)) as unknown as ReturnType<typeof meRepo.update>;
    };
    const spy = vi.spyOn(meRepo, "update").mockImplementation(parked);
    const first = send();
    await entered.promise;
    const second = await send();
    release.resolve();
    const winner = await first;
    expect(winner.statusCode).toBe(200);
    // The loser is told to come back rather than quietly running the write a second time.
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("conflict");
    expect(second.json().error.message).toMatch(/still being processed/);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    // And once the winner has finished, the same key replays its response.
    const again = await send();
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe(winner.body);
    expect(again.headers["idempotency-replayed"]).toBe("true");
  });
  it("takes over a claim abandoned by a crash", async () => {
    const key = randomUUID(); const h = { ...(await authHeaders(app, "u1")), "idempotency-key": key };
    const payload = { ph: "70000 00007" };
    expect((await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload })).statusCode).toBe(200);
    // Rewind the row to what a request that died between COMMIT and onSend leaves behind:
    // a claim with no response. Fresh, it blocks; a minute old, it is fair game.
    const claim = { statusCode: 0, response: sql`'null'::jsonb` };
    const where = eq(idempotencyKeys.key, key);
    await app.db.update(idempotencyKeys).set({ ...claim, createdAt: new Date() }).where(where);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload })).statusCode).toBe(409);
    // Comfortably past CLAIM_STALE_MS (120_000) - a bare 120_000 would sit right on the
    // boundary and could flake depending on how much wall-clock time elapses between this
    // write and the request below.
    await app.db.update(idempotencyKeys).set({ ...claim, createdAt: new Date(Date.now() - 130_000) }).where(where);
    const retry = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers["idempotency-replayed"]).toBeUndefined();
  });
  it("never records a 429 from the rate limiter as the idempotent outcome", async () => {
    // A dedicated app with a tiny budget, sharing `app`'s already-migrated schema/db so this
    // test does not have to seed or migrate anything of its own, and does not drag every other
    // test in this file onto a shared limiter (see security.test.ts for the same pattern).
    const throttled = await buildApp(testConfig({ RATE_LIMIT_PER_MINUTE: "10" }), { db: app.db, migrationsSchema: app.testDb!.schemaName });
    await throttled.ready();
    try {
      const h = await authHeaders(throttled, "u1");
      // Burn the budget with reads: they need no Idempotency-Key, so none of this leaves a claim.
      for (let i = 0; i < 10; i++) {
        expect((await throttled.inject({ method: "GET", url: "/api/v1/me", headers: h })).statusCode, `read ${i + 1}`).toBe(200);
      }
      const key = randomUUID();
      const r = await throttled.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...h, "idempotency-key": key }, payload: { ph: "80000 00008" } });
      expect(r.statusCode).toBe(429);
      expect((await app.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key))).length).toBe(0);
      // The claim is gone, so retrying the same key is a fresh attempt rather than a replay -
      // even though it is still throttled (the budget has not refilled).
      const retry = await throttled.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...h, "idempotency-key": key }, payload: { ph: "80000 00008" } });
      expect(retry.statusCode).toBe(429);
      expect(retry.headers["idempotency-replayed"]).toBeUndefined();
    } finally {
      await throttled.close();
    }
  });
  it("never records a transient 503 as the idempotent outcome", async () => {
    // A test-only write route, mounted (via the real `mount()` a module would use) before
    // `ready()` so it picks up the same authenticate -> roleGate -> idempotency preHandler
    // chain as a real write, then made to fail the way an overloaded dependency would.
    const boomRoute = defineRoute({ method: "POST", path: "/__test/boom", access: "any", response: OkResponseSchema });
    const boomApp = await buildApp(testConfig(), { db: app.db, migrationsSchema: app.testDb!.schemaName });
    mount(boomApp, boomRoute, async () => {
      const err = new Error("simulated overload");
      (err as { statusCode?: number }).statusCode = 503;
      throw err;
    });
    await boomApp.ready();
    try {
      const h = await authHeaders(boomApp, "u1");
      const key = randomUUID();
      const r = await boomApp.inject({ method: "POST", url: "/api/v1/__test/boom", headers: { ...h, "idempotency-key": key } });
      expect(r.statusCode).toBe(503);
      expect((await app.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key))).length).toBe(0);
    } finally {
      await boomApp.close();
    }
  });
  it("purge removes expired rows only", async () => {
    await app.db.update(idempotencyKeys).set({ expiresAt: new Date(Date.now() - 1000) });
    const n = await purgeIdempotencyKeys(app.db);
    expect(n).toBeGreaterThan(0);
    expect((await app.db.select().from(idempotencyKeys)).length).toBe(0);
  });
});
