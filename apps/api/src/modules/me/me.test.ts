import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "me" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("/me", () => {
  it("returns the caller in wire shape", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/me", headers: await authHeaders(app, "u3") });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ user: { id: "u3", n: "Suresh Muthu", e: "suresh.m@royalcare.in", r: "store", rl: "Store Keeper", loc: "store", col: "#0F766E", emp: "RC-2088", ph: "94430 51194" }, mustChangePassword: false });
  });
  it("PATCH updates display fields only and refuses unknown keys", async () => {
    const h = { ...(await authHeaders(app, "u3")), "idempotency-key": randomUUID() };
    const ok = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { ph: "90000 00000" } });
    expect(ok.statusCode).toBe(200); expect(ok.json().user.ph).toBe("90000 00000");
    const bad = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...h, "idempotency-key": randomUUID() }, payload: { r: "buyer" } });
    expect(bad.statusCode).toBe(400); expect(bad.json().error.code).toBe("validation");
  });
});
