import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { App } from "../../app.js";
import { buildTestApp } from "../../test/app.js";
import { truncateAll, warmPool } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { users, refreshTokens } from "../../db/schema/index.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "admin" }); await app.ready(); });
beforeEach(async () => {
  await truncateAll(app.testDb!.db);
  await seedTestDb(app.testDb!.db);
  // u2 (RC-3120, Outlet Manager) is the flagged account throughout this file - an ordinary
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
  it("refuses a caller without the flag - 404, the same as a role without a module", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: await notAdmin() });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

describe("POST /admin/users", () => {
  const body = { name: "Anitha R", email: "anitha.r@royalcare.in", role: "counter", loc: "rest" };
  const create = async (payload: Record<string, unknown> = body) =>
    app.inject({ method: "POST", url: "/api/v1/admin/users", headers: { ...(await admin()), "idempotency-key": randomUUID() }, payload });

  it("creates the account with the next employee number, hands back a temporary password once, and is refused for a non-admin", async () => {
    const res = await create();
    expect(res.statusCode, res.body).toBe(200);
    const j = res.json();
    // The seed's highest number is RC-4482 (Deepa Selvam), so the next one is RC-4483.
    expect(j.result.emp).toBe("RC-4483");
    expect(j.result.mustChangePassword).toBe(true);
    expect(j.result.active).toBe(true);
    expect(j.result.admin).toBe(false);
    expect(typeof j.result.tempPassword).toBe("string");
    expect(j.result.tempPassword.length).toBeGreaterThanOrEqual(10);
    expect(j.changed).toEqual(["accounts"]);
    expect(j.message).toBe("Anitha R (RC-4483) created - the temporary password shown above is not stored anywhere and will not be shown again");

    const second = await create({ ...body, name: "Bala K", email: "bala.k@royalcare.in" });
    expect(second.json().result.emp).toBe("RC-4484");

    const notAdminRes = await app.inject({ method: "POST", url: "/api/v1/admin/users", headers: { ...(await notAdmin()), "idempotency-key": randomUUID() }, payload: body });
    expect(notAdminRes.statusCode).toBe(404);
  });
  it("refuses a body that names its own employee number - the server assigns it", async () => {
    const res = await create({ ...body, emp: "RC-9101" });
    expect(res.statusCode).toBe(400);
    expect(await app.db.select().from(users).where(eq(users.empNo, "RC-9101"))).toHaveLength(0);
  });
  it("counts on from the highest RC- number and steps over one typed in another shape", async () => {
    await app.db.update(users).set({ empNo: "RC-7000" }).where(eq(users.id, "u6"));
    await app.db.update(users).set({ empNo: "E-99999" }).where(eq(users.id, "u1"));
    expect((await create()).json().result.emp).toBe("RC-7001");
  });
  it("gives accounts created at the same moment different numbers and different ids", async () => {
    // Without the `user` sequence row's lock, every one of these reads RC-4482 as the highest
    // number and the same highest id, and all but one fail on the unique index as a 500.
    await warmPool(app.testDb!, 3);
    const names = ["Chitra M", "Dinesh P", "Ezhil V"];
    const results = await Promise.all(names.map((name, i) => create({ ...body, name, email: `staff${i}@royalcare.in` })));
    for (const r of results) expect(r.statusCode, r.body).toBe(200);
    const made = results.map((r) => r.json().result as { id: string; emp: string });
    expect(made.map((m) => m.emp).sort()).toEqual(["RC-4483", "RC-4484", "RC-4485"]);
    expect(new Set(made.map((m) => m.id)).size).toBe(3);
  });
  it("writes an admin_actions row naming the actor and the new account", async () => {
    await create();
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/actions", headers: await admin() });
    const rows = res.json() as Array<{ actor: string; action: string; target: string; details: Record<string, unknown> }>;
    expect(rows[0]).toMatchObject({ actor: "Ramesh Kumar", action: "create", target: "Anitha R", details: { emp: "RC-4483" } });
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

describe("DELETE /admin/users/:id", () => {
  const del = async (id: string, as = admin) =>
    app.inject({ method: "DELETE", url: `/api/v1/admin/users/${id}`, headers: { ...(await as()), "idempotency-key": randomUUID() } });
  const post = async (url: string, payload?: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers: { ...(await admin()), "idempotency-key": randomUUID() }, payload });
  /** A fresh account that never did anything, already deactivated - the one shape a delete takes. */
  const mistake = async (name = "Wrong Person") => {
    const made = (await post("/api/v1/admin/users", { name, email: "wrong@royalcare.in", role: "counter", loc: "kiosk" })).json().result as { id: string; emp: string };
    await post(`/api/v1/admin/users/${made.id}/deactivate`);
    return made;
  };

  it("removes a deactivated account that never did anything, its sessions with it, and the log still names it", async () => {
    const { id, emp } = await mistake();
    await app.db.insert(refreshTokens).values({ userId: id, family: "00000000-0000-4000-8000-000000000011", tokenHash: "h-del", expiresAt: new Date(Date.now() + 100000) });

    const res = await del(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ result: { id, emp, n: "Wrong Person" }, changed: ["accounts"], message: `Wrong Person (${emp}) deleted permanently` });
    expect(await app.db.select().from(users).where(eq(users.id, id))).toHaveLength(0);
    expect(await app.db.select().from(refreshTokens).where(eq(refreshTokens.userId, id))).toHaveLength(0);

    const log = (await app.inject({ method: "GET", url: "/api/v1/admin/actions", headers: await admin() })).json() as Array<{ action: string; target: string; details: Record<string, unknown> }>;
    expect(log.map((l) => [l.action, l.target])).toEqual([["delete", "Wrong Person"], ["deactivate", "Wrong Person"], ["create", "Wrong Person"]]);
    expect(log[0].details).toEqual({ emp });
  });
  it("never hands a deleted account's id to the next one, even when it held the highest", async () => {
    const gone = await mistake();
    expect((await del(gone.id)).statusCode).toBe(200);
    const next = (await post("/api/v1/admin/users", { name: "Right Person", email: "right@royalcare.in", role: "counter", loc: "kiosk" })).json().result as { id: string; emp: string };
    expect(next.id).not.toBe(gone.id);
    expect(Number(next.id.slice(1))).toBeGreaterThan(Number(gone.id.slice(1)));
    // The employee number follows the accounts that exist, so the unused one is given out again.
    expect(next.emp).toBe(gone.emp);
  });
  it("refuses the caller's own account", async () => {
    const res = await del("u2");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe("You cannot delete your own account from here.");
  });
  it("refuses a super admin account", async () => {
    await app.db.update(users).set({ admin: true, active: false }).where(eq(users.id, "u3"));
    const res = await del("u3");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe("Refused - Suresh Muthu (RC-2088) is a super admin, and a super admin account is never deleted");
  });
  it("refuses an account that is still active", async () => {
    const res = await del("u6");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe("Deactivate Deepa Selvam (RC-4482) before deleting the account");
    expect(await app.db.select().from(users).where(eq(users.id, "u6"))).toHaveLength(1);
  });
  it("refuses an account with history, and leaves it - sessions included - exactly as it was", async () => {
    // Kavitha Raman raised stock requests in the seed, so a row in the hospital's history names her.
    await post("/api/v1/admin/users/u1/deactivate");
    await app.db.insert(refreshTokens).values({ userId: "u1", family: "00000000-0000-4000-8000-000000000012", tokenHash: "h-hist", expiresAt: new Date(Date.now() + 100000) });
    const res = await del("u1");
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe("Refused - Kavitha Raman (RC-4471) has records in the hospital's history, so the account can only be deactivated, never deleted");
    expect(await app.db.select().from(users).where(eq(users.id, "u1"))).toHaveLength(1);
    expect(await app.db.select().from(refreshTokens).where(eq(refreshTokens.userId, "u1"))).toHaveLength(1);
    const log = (await app.inject({ method: "GET", url: "/api/v1/admin/actions", headers: await admin() })).json() as Array<{ action: string }>;
    expect(log.map((l) => l.action)).not.toContain("delete");
  });
  it("answers 404 for an id that does not exist, and for a caller without the flag", async () => {
    expect((await del("u999")).statusCode).toBe(404);
    expect((await del("u6", notAdmin)).statusCode).toBe(404);
  });
});

describe("a super admin has no role in practice", () => {
  it("reaches account management and its own record, and no operational route its placeholder role would open", async () => {
    // u2's placeholder role is manager: without the admin restriction every one of these answers.
    const h = await admin();
    expect((await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: h })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/v1/payers", headers: h })).statusCode).toBe(404);
    const write = await app.inject({ method: "POST", url: "/api/v1/availability/toggle", headers: { ...h, "idempotency-key": randomUUID() }, payload: { loc: "rest", it: "juice" } });
    expect(write.statusCode).toBe(404);
    expect(write.json().error.message).toBe("There is nothing at POST /api/v1/availability/toggle.");

    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: h });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ admin: true, rl: "Super Admin" });
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: h })).statusCode).toBe(200);
  });
  it("is labelled Super Admin in the account list, and its role or location cannot be changed", async () => {
    await app.db.update(users).set({ admin: true }).where(eq(users.id, "u3"));
    const list = (await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: await admin() })).json() as Array<{ id: string; rl: string }>;
    expect(list.find((u) => u.id === "u3")!.rl).toBe("Super Admin");
    expect(list.find((u) => u.id === "u1")!.rl).toBe("Counter Operator");

    const res = await app.inject({ method: "PATCH", url: "/api/v1/admin/users/u3", headers: { ...(await admin()), "idempotency-key": randomUUID() }, payload: { role: "buyer", loc: "store" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe("Refused - Suresh Muthu (RC-2088) is a super admin, and a super admin has no role or location to change");
    const [u] = await app.db.select().from(users).where(eq(users.id, "u3"));
    expect([u.role, u.loc]).toEqual(["store", "store"]);
  });
});
