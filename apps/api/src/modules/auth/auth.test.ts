import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import type { App } from "../../app.js";
import { refreshTokens, users } from "../../db/schema/index.js";
import { Attempts } from "./service.js";
import { purgeRefreshTokens } from "./repo.js";

/**
 * Two apps, per the controller ruling: the login route carries a per-IP rate limit
 * (default 10/min, keyed on IP for an unauthenticated request). Every test here except
 * "rate-limits repeated failures per employee id" shares app `a`, whose per-IP limit is
 * raised well above the number of login calls this file makes. The per-employee test needs
 * the *default* per-IP and per-employee limits to interact correctly (6 calls, comfortably
 * under the per-IP 10), so it gets its own app `b` on a separate schema.
 */
let a: App;
let b: App;
beforeAll(async () => {
  a = await buildTestApp({ schema: "auth", env: { LOGIN_RATE_LIMIT_PER_MINUTE: "100" } });
  await seedTestDb(a.testDb!.db);
  await a.ready();
  b = await buildTestApp({ schema: "auth_limits" });
  await seedTestDb(b.testDb!.db);
  await b.ready();
});
afterAll(async () => {
  await a.close();
  await b.close();
});

const login = (app: App, emp = "RC-4471", password = "changeme") =>
  app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { emp, password } });
const cookieOf = (r: { cookies: Array<{ name: string; value: string }> }) => r.cookies.find((c) => c.name === "rch_refresh")!;

describe("login", () => {
  it("returns an access token and the wire user, and sets the refresh cookie", async () => {
    const r = await login(a);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.user).toMatchObject({ id: "u1", n: "Kavitha Raman", r: "counter", loc: "coffee", emp: "RC-4471" });
    expect(body.mustChangePassword).toBe(false);
    expect(typeof body.accessToken).toBe("string");
    const c = cookieOf(r);
    expect(c).toBeDefined();
    expect(r.headers["set-cookie"]).toMatch(/HttpOnly/);
    expect(r.headers["set-cookie"]).toMatch(/SameSite=Strict/);
    expect(r.headers["set-cookie"]).toMatch(/Path=\/api\/v1\/auth/);
  });
  it("refuses a wrong password and an unknown employee with the same message", async () => {
    const x = await login(a, "RC-4471", "nope");
    const y = await login(a, "RC-0000", "changeme");
    expect(x.statusCode).toBe(401);
    expect(y.statusCode).toBe(401);
    expect(x.json().error.message).toBe(y.json().error.message);
  });
  it("refuses a deactivated user", async () => {
    await a.db.update(users).set({ active: false }).where(eq(users.id, "u6"));
    expect((await login(a, "RC-4482")).statusCode).toBe(401);
  });
});

describe("login rate limit per employee id", () => {
  it("rate-limits repeated failures per employee id", async () => {
    for (let i = 0; i < 5; i++) await login(b, "RC-3120", "wrong");
    const r = await login(b, "RC-3120", "changeme");
    expect(r.statusCode).toBe(429);
  });
});

describe("refresh", () => {
  it("rotates: new access + new cookie, old cookie is dead, reuse revokes the family", async () => {
    const first = await login(a, "RC-2088");
    const c1 = cookieOf(first).value;
    const r2 = await a.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c1 } });
    expect(r2.statusCode).toBe(200);
    const c2 = cookieOf(r2).value;
    expect(c2).not.toBe(c1);
    // replaying the used token is reuse: family revoked, and the fresh token dies with it
    const reuse = await a.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c1 } });
    expect(reuse.statusCode).toBe(401);
    // a dead refresh cookie is also cleared client-side, so the browser stops presenting it
    expect(reuse.headers["set-cookie"]).toMatch(/rch_refresh=;/);
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c2 } })).statusCode).toBe(401);
    const rows = await a.db.select().from(refreshTokens).where(eq(refreshTokens.userId, "u3"));
    expect(rows.every((t) => t.revokedAt !== null)).toBe(true);
  });
  it("refuses without a cookie", async () => {
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/refresh" })).statusCode).toBe(401);
  });
  it("under concurrent reuse of the same cookie, exactly one refresh wins and the family dies with it", async () => {
    const first = await login(a, "RC-2088");
    const c1 = cookieOf(first).value;
    const [r1, r2] = await Promise.all([
      a.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c1 } }),
      a.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c1 } }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 401]);
    const winner = r1.statusCode === 200 ? r1 : r2;
    const c2 = cookieOf(winner).value;
    // The loser's atomic claim fails, which revokes the whole family - including the token
    // the winner just minted in the same race.
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c2 } })).statusCode).toBe(401);
  });
});

describe("logout", () => {
  it("logout revokes the family and clears the cookie", async () => {
    const l = await login(a, "RC-1902");
    const c = cookieOf(l).value;
    const out = await a.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { rch_refresh: c } });
    expect(out.statusCode).toBe(200);
    expect(out.headers["set-cookie"]).toMatch(/rch_refresh=;/);
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c } })).statusCode).toBe(401);
  });
});

describe("change-password", () => {
  it("needs the current password, then the old one stops working", async () => {
    const l = await login(a, "RC-1550");
    const h = { authorization: `Bearer ${l.json().accessToken}` };
    const bad = await a.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: h, payload: { current: "wrong", next: "a-much-longer-secret" } });
    expect(bad.statusCode).toBe(401);
    const ok = await a.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: h, payload: { current: "changeme", next: "a-much-longer-secret" } });
    expect(ok.statusCode).toBe(200);
    expect((await login(a, "RC-1550", "changeme")).statusCode).toBe(401);
    expect((await login(a, "RC-1550", "a-much-longer-secret")).statusCode).toBe(200);
  });
  it("hands back a working session: the old cookie is dead, the new token and cookie are not", async () => {
    const l = await login(a, "RC-1902");
    const oldCookie = cookieOf(l).value;
    const h = { authorization: `Bearer ${l.json().accessToken}` };
    const cp = await a.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: h, payload: { current: "changeme", next: "a-much-longer-secret-3" } });
    expect(cp.statusCode).toBe(200);
    const body = cp.json();
    expect(body.mustChangePassword).toBe(false);
    expect(body.user.id).toBe("u4");
    // The token in the reply is usable straight away - no reload, no second sign-in.
    const snap = await a.inject({ method: "GET", url: "/api/v1/snapshot", headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(snap.statusCode).toBe(200);
    // The cookie it set refreshes; the one the caller arrived with was revoked by the change.
    const fresh = cookieOf(cp).value;
    expect(fresh).not.toBe(oldCookie);
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: oldCookie } })).statusCode).toBe(401);
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: fresh } })).statusCode).toBe(200);
  });
});

describe("must-change password", () => {
  it("a must-change user can reach change-password but not /snapshot, and the reply un-gates them", async () => {
    await a.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, "u2"));
    const l = await login(a, "RC-3120");
    expect(l.json().mustChangePassword).toBe(true);
    const h = { authorization: `Bearer ${l.json().accessToken}` };
    const snap = await a.inject({ method: "GET", url: "/api/v1/snapshot", headers: h });
    expect(snap.statusCode).toBe(403);
    expect(snap.json().error.message).toMatch(/password/i);
    const cp = await a.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: h,
      payload: { current: "changeme", next: "a-much-longer-secret-2" },
    });
    expect(cp.statusCode).toBe(200);
    expect(cp.json().mustChangePassword).toBe(false);
    // The whole point of I1: the token that comes back is no longer mcp-gated, so the very
    // next call the client makes - loadSnapshot() - succeeds instead of 403-ing.
    const after = await a.inject({ method: "GET", url: "/api/v1/snapshot", headers: { authorization: `Bearer ${cp.json().accessToken}` } });
    expect(after.statusCode).toBe(200);
  });
});

describe("per-employee attempt map", () => {
  it("evicts the oldest key once it is full, so an unbounded stream of employee ids cannot grow it", () => {
    const at = new Attempts(5, 60_000, 3);
    for (const k of ["a", "b", "c", "d", "e"]) at.hit(k);
    expect(at.size).toBe(3);
    // "a" and "b" were pushed out; the survivors keep their windows.
    expect(at.hit("c")).toBe(false);
    expect(at.size).toBe(3);
  });
  it("drops keys whose window has gone quiet", () => {
    const at = new Attempts(5, 10);
    at.hit("gone");
    expect(at.size).toBe(1);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 1000);
      at.sweep();
      expect(at.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("purging refresh tokens", () => {
  it("removes expired and long-revoked rows and keeps live ones", async () => {
    const day = 86400_000;
    const rows = [
      { id: randomUUID(), userId: "u1", family: randomUUID(), tokenHash: "expired", expiresAt: new Date(Date.now() - day) },
      { id: randomUUID(), userId: "u1", family: randomUUID(), tokenHash: "old-revoke", expiresAt: new Date(Date.now() + day), revokedAt: new Date(Date.now() - 8 * day) },
      { id: randomUUID(), userId: "u1", family: randomUUID(), tokenHash: "just-revoked", expiresAt: new Date(Date.now() + day), revokedAt: new Date() },
      { id: randomUUID(), userId: "u1", family: randomUUID(), tokenHash: "live", expiresAt: new Date(Date.now() + day) },
    ];
    await b.db.insert(refreshTokens).values(rows);
    expect(await purgeRefreshTokens(b.db)).toBe(2);
    const left = (await b.db.select().from(refreshTokens)).map((t) => t.tokenHash).sort();
    expect(left).toEqual(["just-revoked", "live"]);
  });
});
