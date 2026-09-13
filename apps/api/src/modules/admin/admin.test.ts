import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { App } from "../../app.js";
import { buildTestApp } from "../../test/app.js";
import { truncateAll } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { users, refreshTokens } from "../../db/schema/index.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "admin" }); await app.ready(); });
beforeEach(async () => {
  await truncateAll(app.testDb!.db);
  await seedTestDb(app.testDb!.db);
  // u2 (RC-3120, Outlet Manager) is the flagged account throughout this file — an ordinary
  // role, flagged, exactly the shape the design calls for. Nobody else in the seed carries it.
  await app.db.update(users).set({ admin: true }).where(eq(users.id, "u2"));
});
afterAll(async () => { await app.close(); });

const admin = () => authHeaders(app, "u2");
const notAdmin = () => authHeaders(app, "u1");

describe("GET /admin/users", () => {
  it("answers with every account, including an inactive one, in the admin's own wire shape", async () => {
    await app.db.update(users).set({ active: false }).where(eq(users.id, "u6"));
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: await admin() });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string; emp: string; active: boolean; admin: boolean }>;
    expect(rows.map((r) => r.emp)).toEqual(expect.arrayContaining(["RC-4471", "RC-3120", "RC-2088", "RC-1902", "RC-1550", "RC-4482"]));
    expect(rows.find((r) => r.id === "u6")!.active).toBe(false);
    expect(rows.find((r) => r.id === "u2")!.admin).toBe(true);
    expect(rows.find((r) => r.id === "u1")!.admin).toBe(false);
  });
  it("refuses a caller without the flag — 404, the same as a role without a module", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: await notAdmin() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("POST /admin/users", () => {
  const body = { emp: "RC-9101", name: "Anitha R", email: "anitha.r@royalcare.in", role: "counter", loc: "rest" };
  it("creates the account, hands back a temporary password once, and is refused for a non-admin", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/users", headers: { ...(await admin()), "idempotency-key": randomUUID() }, payload: body });
    expect(res.statusCode, res.body).toBe(200);
    const j = res.json();
    expect(j.result.emp).toBe("RC-9101");
    expect(j.result.mustChangePassword).toBe(true);
    expect(j.result.active).toBe(true);
    expect(j.result.admin).toBe(false);
    expect(typeof j.result.tempPassword).toBe("string");
    expect(j.result.tempPassword.length).toBeGreaterThanOrEqual(10);
    expect(j.changed).toEqual(["accounts"]);
    expect(j.message).toContain("RC-9101");

    const notAdminRes = await app.inject({ method: "POST", url: "/api/v1/admin/users", headers: { ...(await notAdmin()), "idempotency-key": randomUUID() }, payload: { ...body, emp: "RC-9102" } });
    expect(notAdminRes.statusCode).toBe(404);
  });
  it("refuses a duplicate employee number with the domain's own sentence", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/users", headers: { ...(await admin()), "idempotency-key": randomUUID() }, payload: { ...body, emp: "RC-4471" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("RC-4471");
  });
  it("writes an admin_actions row naming the actor and the new account", async () => {
    await app.inject({ method: "POST", url: "/api/v1/admin/users", headers: { ...(await admin()), "idempotency-key": randomUUID() }, payload: body });
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/actions", headers: await admin() });
    const rows = res.json() as Array<{ actor: string; action: string; target: string }>;
    expect(rows[0]).toMatchObject({ actor: "Ramesh Kumar", action: "create", target: "Anitha R" });
  });
});

describe("POST /admin/users/:id/reset-password", () => {
  it("mints a fresh temporary password, revokes sessions, and is not the same twice", async () => {
    await app.db.insert(refreshTokens).values({ userId: "u1", family: "00000000-0000-4000-8000-000000000009", tokenHash: "h", expiresAt: new Date(Date.now() + 100000) });
    const first = await app.inject({ method: "POST", url: "/api/v1/admin/users/u1/reset-password", headers: { ...(await admin()), "idempotency-key": randomUUID() } });
    const second = await app.inject({ method: "POST", url: "/api/v1/admin/users/u1/reset-password", headers: { ...(await admin()), "idempotency-key": randomUUID() } });
    expect(first.statusCode).toBe(200);
    expect(first.json().result.tempPassword).not.toBe(second.json().result.tempPassword);
    expect((await app.db.select().from(refreshTokens).where(eq(refreshTokens.userId, "u1")))[0].revokedAt).not.toBeNull();
  });
  it("answers 404 for an id that does not exist", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/users/u999/reset-password", headers: { ...(await admin()), "idempotency-key": randomUUID() } });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /admin/users/:id/deactivate and /reactivate", () => {
  it("deactivates, then reactivates, the same account", async () => {
    const off = await app.inject({ method: "POST", url: "/api/v1/admin/users/u1/deactivate", headers: { ...(await admin()), "idempotency-key": randomUUID() } });
    expect(off.statusCode).toBe(200);
    expect(off.json().result.active).toBe(false);
    const on = await app.inject({ method: "POST", url: "/api/v1/admin/users/u1/reactivate", headers: { ...(await admin()), "idempotency-key": randomUUID() } });
    expect(on.statusCode).toBe(200);
    expect(on.json().result.active).toBe(true);
  });
  it("refuses to deactivate the caller's own account", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/admin/users/u2/deactivate", headers: { ...(await admin()), "idempotency-key": randomUUID() } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("own account");
    const [u] = await app.db.select().from(users).where(eq(users.id, "u2"));
    expect(u.active).toBe(true);
  });
});

describe("PATCH /admin/users/:id", () => {
  it("changes the role and location together, and revokes sessions", async () => {
    await app.db.insert(refreshTokens).values({ userId: "u1", family: "00000000-0000-4000-8000-000000000010", tokenHash: "h2", expiresAt: new Date(Date.now() + 100000) });
    const res = await app.inject({ method: "PATCH", url: "/api/v1/admin/users/u1", headers: { ...(await admin()), "idempotency-key": randomUUID() }, payload: { role: "counter", loc: "kiosk" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ r: "counter", loc: "kiosk" });
    expect((await app.db.select().from(refreshTokens).where(eq(refreshTokens.userId, "u1")))[0].revokedAt).not.toBeNull();
  });
  it("refuses a role/location pairing that role never works at", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/v1/admin/users/u1", headers: { ...(await admin()), "idempotency-key": randomUUID() }, payload: { role: "prod", loc: "coffee" } });
    expect(res.statusCode).toBe(400);
  });
  it("refuses to change the caller's own role or location", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/v1/admin/users/u2", headers: { ...(await admin()), "idempotency-key": randomUUID() }, payload: { role: "manager", loc: "coffee" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain("own");
  });
});

describe("GET /admin/actions", () => {
  it("is refused to a non-admin the same way, and lists nothing before anything has happened", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/actions", headers: await admin() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    const refused = await app.inject({ method: "GET", url: "/api/v1/admin/actions", headers: await notAdmin() });
    expect(refused.statusCode).toBe(404);
  });
});
