import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "../test/app.js";
import { seedTestDb } from "../test/seed.js";
import { authHeaders } from "../test/auth.js";
import type { App } from "../app.js";
import { purgeIdempotencyKeys } from "./idempotency.js";
import { idempotencyKeys } from "../db/schema/index.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "idem" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

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
  it("purge removes expired rows only", async () => {
    await app.db.update(idempotencyKeys).set({ expiresAt: new Date(Date.now() - 1000) });
    const n = await purgeIdempotencyKeys(app.db);
    expect(n).toBeGreaterThan(0);
    expect((await app.db.select().from(idempotencyKeys)).length).toBe(0);
  });
});
