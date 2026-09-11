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
  it("refuses a name longer than the column will ever need, rather than storing it into every snapshot", async () => {
    const h = { ...(await authHeaders(app, "u3")), "idempotency-key": randomUUID() };
    const long = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: h, payload: { n: "a".repeat(200) } });
    expect(long.statusCode).toBe(400); expect(long.json().error.code).toBe("validation");
    // The other two strings are bounded for the same reason: a display name, a phone number and
    // an email address all get read back by everyone who can see the roster.
    const phone = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...h, "idempotency-key": randomUUID() }, payload: { ph: "9".repeat(60) } });
    expect(phone.statusCode).toBe(400);
    const email = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { ...h, "idempotency-key": randomUUID() }, payload: { e: `${"a".repeat(250)}@royalcare.in` } });
    expect(email.statusCode).toBe(400);
    // and the row is untouched
    const now = await app.inject({ method: "GET", url: "/api/v1/me", headers: await authHeaders(app, "u3") });
    expect(now.json().user.n).toBe("Suresh Muthu");
  });
});
