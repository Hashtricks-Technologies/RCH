import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { buildTestApp } from "../test/app.js";
import { seedTestDb } from "../test/seed.js";
import { authHeaders } from "../test/auth.js";
import type { App } from "../app.js";
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
    await app.db.update(idempotencyKeys).set({ ...claim, createdAt: new Date(Date.now() - 120_000) }).where(where);
    const retry = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers["idempotency-replayed"]).toBeUndefined();
  });
  it("purge removes expired rows only", async () => {
    await app.db.update(idempotencyKeys).set({ expiresAt: new Date(Date.now() - 1000) });
    const n = await purgeIdempotencyKeys(app.db);
    expect(n).toBeGreaterThan(0);
    expect((await app.db.select().from(idempotencyKeys)).length).toBe(0);
  });
});
