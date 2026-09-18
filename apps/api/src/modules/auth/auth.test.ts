import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { warmPool } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import type { App } from "../../app.js";
import { locations, refreshTokens, userPostings, users } from "../../db/schema/index.js";
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
/** Where a minted access token says this session is standing - the one claim every location guard
 *  on the server reads, so this is the thing a switch has to actually move. */
const claimLoc = (app: App, token: string) => (app.jwt.decode(token) as { loc: string }).loc;

describe("GET /auth/directory", () => {
  it("lists who can sign in - number and name only, in number order - to a caller with no token", async () => {
    const res = await a.inject({ method: "GET", url: "/api/v1/auth/directory" });
    expect(res.statusCode).toBe(200);
    // The seed's six staff, and not RC-0001: the admin-flagged account is never advertised.
    expect(res.json()).toEqual([
      { emp: "RC-1550", n: "Latha Narayanan" },
      { emp: "RC-1902", n: "Vinoth Prakash" },
      { emp: "RC-2088", n: "Suresh Muthu" },
      { emp: "RC-3120", n: "Ramesh Kumar" },
      { emp: "RC-4471", n: "Kavitha Raman" },
      { emp: "RC-4482", n: "Deepa Selvam" },
    ]);
  });
  it("leaves out a deactivated account", async () => {
    await a.db.update(users).set({ active: false }).where(eq(users.id, "u4"));
    try {
      const emps = (await a.inject({ method: "GET", url: "/api/v1/auth/directory" })).json().map((e: { emp: string }) => e.emp);
      expect(emps).not.toContain("RC-1902");
      expect(emps).toHaveLength(5);
    } finally {
      await a.db.update(users).set({ active: true }).where(eq(users.id, "u4"));
    }
  });
});

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
  it("logs why it refused - no such employee, wrong password, deactivated - without the sentence changing, and never logs an unknown id", async () => {
    // Its own app so the stream is this test's alone. The login route's per-IP limit is
    // raised the same way `a`'s is.
    const lines: Array<Record<string, unknown>> = [];
    const c = await buildTestApp({ schema: "auth_log", env: { LOGIN_RATE_LIMIT_PER_MINUTE: "100", LOG_LEVEL: "info" },
      logStream: { write: (s: string) => { for (const l of s.split("\n")) if (l) lines.push(JSON.parse(l) as Record<string, unknown>); } } });
    await seedTestDb(c.testDb!.db);
    await c.ready();
    try {
      await c.db.update(users).set({ active: false }).where(eq(users.id, "u6"));
      const wrong = await login(c, "RC-4471", "nope");
      const unknown = await login(c, "RC-0000", "changeme");
      const gone = await login(c, "RC-4482", "changeme");
      for (const r of [wrong, unknown, gone]) expect(r.json().error.message).toBe("That employee id and password do not match.");

      const causes = lines.filter((l) => l.msg === "request" && l.route === "/api/v1/auth/login").map((l) => (l.refusal as { cause?: string } | undefined)?.cause);
      expect(causes).toEqual(["wrong password for RC-4471", "no such employee", "RC-4482 is deactivated"]);
      // What was typed into the id field is never written down when it matched nobody: an
      // operator who types their password into the wrong box must not find it in the log.
      expect(JSON.stringify(lines)).not.toContain("RC-0000");
    } finally {
      await c.db.update(users).set({ active: true }).where(eq(users.id, "u6"));
      await c.close();
    }
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
  it("counts only failed sign-ins against the employee id, so five correct ones in a minute do not lock anybody out", async () => {
    // The budget used to be spent before the password was even looked at, and handed back only
    // once the sign-in had finished. Five tills coming on shift together - every one of them
    // typing the right password - therefore all reached the counter before any of them gave a
    // slot back, and the last was refused. A correct sign-in gives its own slot back now, so a
    // whole budget's worth of them at once still all get in.
    // App `a`, whose per-IP budget is raised to 100, so what is measured here is the
    // per-employee counter (still the default five) and nothing else. RC-3120 rather than one
    // of the ids the refresh suite below counts rows for - five sign-ins mint five refresh
    // families, and "reuse revokes the family" asserts over all of one user's.
    // Four is the test pool's own `max` (test/db.ts): asking warmPool for more than the pool can
    // ever hold never resolves, and the held connections are never given back.
    await warmPool(a.testDb!, 4);
    const rs = await Promise.all(Array.from({ length: 5 }, () => login(a, "RC-3120")));
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
  });
  it("spends the budget when an attempt starts, so simultaneous guesses cannot all get past the gate", async () => {
    // Argon2 takes 50–100 ms. A counter that only saw settled failures would let every one of
    // these six through - they all arrive before any of them has finished failing - which is
    // both an unlimited guessing window and six cores burned on demand. The slot is taken by
    // `begin` before the verify, so exactly five reach the verifier and the sixth is refused
    // without one. RC-9999 is not a seeded employee: the id is left locked for the rest of the
    // minute, and nothing else in this file signs in as it.
    // Four, the test pool's `max` - see the note above. The gate itself is reached before any
    // query anyway (`isLocked` and `begin` run before the first await), so the six requests are
    // held to the budget whether or not they get a connection each.
    await warmPool(a.testDb!, 4);
    const rs = await Promise.all(Array.from({ length: 6 }, () => login(a, "RC-9999", "guess")));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([401, 401, 401, 401, 401, 429]);
    expect(rs.find((r) => r.statusCode === 429)!.json().error.message)
      .toBe("Too many attempts for that employee id - wait a minute and try again.");
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
    // `pg` connects lazily: without two warm connections the two "concurrent" refreshes below
    // run back to back on one, and the test passes even with `markUsed`'s atomic claim removed.
    await warmPool(a.testDb!, 2);
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
  it("caps a rotated token's expiry at 30 days from the family's first issue, not 30 days from the rotation", async () => {
    const day = 86400_000;
    const first = await login(a, "RC-1902");
    const c1 = cookieOf(first).value;
    const [row] = await a.db.select().from(refreshTokens).where(eq(refreshTokens.userId, first.json().user.id)).orderBy(sql`created_at desc`).limit(1);
    // Back-date the family's first (only, so far) row by 29 days: a rotation issued "now" would
    // ordinarily get a fresh now+30d expiry, but the family itself is only a day from its
    // absolute 30-day lifetime, so the rotated token must inherit that cap.
    const backdated = new Date(Date.now() - 29 * day);
    await a.db.update(refreshTokens).set({ createdAt: backdated }).where(eq(refreshTokens.id, row.id));
    const r2 = await a.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c1 } });
    expect(r2.statusCode).toBe(200);
    const familyRows = await a.db.select().from(refreshTokens).where(eq(refreshTokens.family, row.family));
    const rotated = familyRows.find((x) => x.id !== row.id)!;
    const expectedCap = backdated.getTime() + 30 * day;
    expect(Math.abs(rotated.expiresAt.getTime() - expectedCap)).toBeLessThan(5000);
    // Well short of an ordinary now+30d expiry, which is what a bug would give it.
    expect(rotated.expiresAt.getTime()).toBeLessThan(Date.now() + 29 * day);
    // The cookie dies with the row: its Expires carries the same cap.
    const cookieExpires = (r2.cookies.find((c) => c.name === "rch_refresh") as { expires?: Date } | undefined)?.expires;
    expect(Math.abs((cookieExpires?.getTime() ?? 0) - expectedCap)).toBeLessThan(5000);
  });
  it("refuses to rotate a family older than 30 days even when the row's own expiry is still ahead", async () => {
    const day = 86400_000;
    const first = await login(a, "RC-1902");
    const c1 = cookieOf(first).value;
    const [row] = await a.db.select().from(refreshTokens).where(eq(refreshTokens.userId, first.json().user.id)).orderBy(sql`created_at desc`).limit(1);
    // A row minted before the absolute cap existed: created 31 days ago, its own expiry still ahead.
    await a.db.update(refreshTokens).set({ createdAt: new Date(Date.now() - 31 * day) }).where(eq(refreshTokens.id, row.id));
    const r2 = await a.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: c1 } });
    expect(r2.statusCode).toBe(401);
    expect(r2.json().error.message).toBe("Your session has expired - sign in again.");
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

/**
 * `user_postings` is where an account **may** work; the token's `loc` claim is where it **is**
 * working, and it stays exactly one location. Everything below is about keeping those two apart:
 * the list travels on the sign-in response so the picker has something to offer, and the claim
 * moves only when somebody asks it to - never on a silent refresh, which is the defect the
 * refresh row's own `loc` column exists to prevent.
 */
describe("postings and switch-location", () => {
  // `describe("login")` above leaves RC-4482 deactivated, and this file shares one app.
  beforeAll(async () => { await a.db.update(users).set({ active: true }).where(eq(users.id, "u6")); });
  /** The refresh row a cookie stands for. The column stores the hash, never the token. */
  const hashOf = (raw: string) => createHash("sha256").update(raw).digest("hex");
  const rowFor = async (app: App, cookie: string) =>
    (await app.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hashOf(cookie))))[0];
  const switchTo = (app: App, loc: string, accessToken: string, cookie?: string) =>
    app.inject({
      method: "POST", url: "/api/v1/auth/switch-location",
      headers: { authorization: `Bearer ${accessToken}` },
      ...(cookie ? { cookies: { rch_refresh: cookie } } : {}),
      payload: { loc },
    });
  const refresh = (app: App, cookie: string) =>
    app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: cookie } });

  it("signs in at the home counter and says which others the account may stand at", async () => {
    const body = (await login(a, "RC-4471")).json();
    // The demo hospital posts Kavitha Raman to her own Coffee Shop and to the Snack Kiosk.
    expect(body.postings).toEqual(["coffee", "kiosk"]);
    expect(body.user.loc).toBe("coffee");
    expect(claimLoc(a, body.accessToken)).toBe("coffee");
  });

  it("leaves an account with one posting exactly as it was before any of this existed", async () => {
    const body = (await login(a, "RC-4482")).json();
    expect(body.postings).toEqual(["kiosk"]);
    expect(body.user.loc).toBe("kiosk");
    // There is nowhere for it to switch to, and asking is refused rather than quietly allowed.
    const r = await switchTo(a, "coffee", body.accessToken);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("You are not posted to Coffee Shop.");
  });

  it("moves the session: the claim, the wire user and the session's own refresh row all follow", async () => {
    const l = await login(a, "RC-4471");
    const c = cookieOf(l).value;
    const r = await switchTo(a, "kiosk", l.json().accessToken, c);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(claimLoc(a, body.accessToken)).toBe("kiosk");
    expect(body.user.loc).toBe("kiosk");
    expect(body.postings).toEqual(["coffee", "kiosk"]);
    // Nothing is rotated: it is the same session, standing somewhere else, so no new cookie is set.
    expect(r.cookies.find((x) => x.name === "rch_refresh")).toBeUndefined();
    expect((await rowFor(a, c)).loc).toBe("kiosk");
  });

  it("keeps the switched counter across a silent refresh, and across the one after that", async () => {
    // The defect this is here for: a token expires every fifteen minutes, so without the refresh
    // row's own `loc` the next silent rotation re-reads `users.loc` and walks a consultant back to
    // their home till in the middle of somebody else's shift.
    const l = await login(a, "RC-4471");
    const c1 = cookieOf(l).value;
    expect((await switchTo(a, "kiosk", l.json().accessToken, c1)).statusCode).toBe(200);

    const r2 = await refresh(a, c1);
    expect(r2.statusCode).toBe(200);
    expect(claimLoc(a, r2.json().accessToken)).toBe("kiosk");
    expect(r2.json().user.loc).toBe("kiosk");

    const c2 = cookieOf(r2).value;
    expect((await rowFor(a, c2)).loc).toBe("kiosk");
    const r3 = await refresh(a, c2);
    expect(claimLoc(a, r3.json().accessToken)).toBe("kiosk");
  });

  it("stands a session opened before postings existed at its home counter", async () => {
    const l = await login(a, "RC-4471");
    const c = cookieOf(l).value;
    // Null is every refresh row migration 0023 found already on the table.
    await a.db.update(refreshTokens).set({ loc: null }).where(eq(refreshTokens.tokenHash, hashOf(c)));
    const r = await refresh(a, c);
    expect(r.statusCode).toBe(200);
    expect(claimLoc(a, r.json().accessToken)).toBe("coffee");
  });

  it("refuses a counter the account is not posted to, naming it", async () => {
    const l = await login(a, "RC-4471");
    const c = cookieOf(l).value;
    const r = await switchTo(a, "rest", l.json().accessToken, c);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("You are not posted to Restaurant.");
    // The refused switch moved nothing: the session is still at the counter it was at.
    expect((await rowFor(a, c)).loc).toBe("coffee");
    expect(claimLoc(a, (await refresh(a, c)).json().accessToken)).toBe("coffee");
  });

  it("refuses a closed outlet, even one the account is posted to", async () => {
    const l = await login(a, "RC-4471");
    const c = cookieOf(l).value;
    await a.db.update(locations).set({ active: false }).where(eq(locations.key, "kiosk"));
    try {
      const r = await switchTo(a, "kiosk", l.json().accessToken, c);
      expect(r.statusCode).toBe(422);
      expect(r.json().error.message).toBe("Refused - Snack Kiosk is closed; nothing may be sold there");
      expect((await rowFor(a, c)).loc).toBe("coffee");
    } finally {
      await a.db.update(locations).set({ active: true }).where(eq(locations.key, "kiosk"));
    }
  });

  it("answers 404 for a location the hospital does not have", async () => {
    const l = await login(a, "RC-4471");
    const r = await switchTo(a, "nowhere", l.json().accessToken, cookieOf(l).value);
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no location nowhere.");
  });

  it("offers a posting an administrator added at the very next sign-in", async () => {
    // Read off `user_postings`, not off the account's own row: adding one here is the whole of
    // what putting a consultant on a second till amounts to.
    await a.db.insert(userPostings).values({ userId: "u6", loc: "coffee" });
    try {
      const l = await login(a, "RC-4482");
      expect(l.json().postings).toEqual(["coffee", "kiosk"]);
      const r = await switchTo(a, "coffee", l.json().accessToken, cookieOf(l).value);
      expect(r.statusCode, r.body).toBe(200);
      expect(claimLoc(a, r.json().accessToken)).toBe("coffee");
    } finally {
      await a.db.delete(userPostings).where(and(eq(userPostings.userId, "u6"), eq(userPostings.loc, "coffee")));
    }
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
  it("refuses an account deactivated after the access token was issued, with the same message as a bad current password", async () => {
    const l = await login(a, "RC-4471");
    const h = { authorization: `Bearer ${l.json().accessToken}` };
    await a.db.update(users).set({ active: false }).where(eq(users.id, "u1"));
    const inactive = await a.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: h, payload: { current: "changeme", next: "a-much-longer-secret" } });
    const badCurrent = await a.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: h, payload: { current: "wrong", next: "a-much-longer-secret" } });
    expect(inactive.statusCode).toBe(401);
    expect(badCurrent.statusCode).toBe(401);
    expect(inactive.json().error.message).toBe(badCurrent.json().error.message);
  });
  it("refuses a next password equal to the current one", async () => {
    const l = await login(a, "RC-1550", "a-much-longer-secret");
    const h = { authorization: `Bearer ${l.json().accessToken}` };
    const r = await a.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: h, payload: { current: "a-much-longer-secret", next: "a-much-longer-secret" } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Choose a different password from your current one.");
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
    for (const k of ["a", "b", "c", "d", "e"]) at.begin(k);
    expect(at.size).toBe(3);
    // "a" and "b" were pushed out; the survivors keep their windows. (`begin` records an attempt
    // about to be verified and answers the stamp that gives it back - whether a key is over
    // budget is `isLocked`'s question, which login asks before it spends a slot.)
    at.begin("c");
    expect(at.isLocked("c")).toBe(false);
    expect(at.size).toBe(3);
  });
  it("gives back the attempt that turned out to be correct, and only that one", () => {
    const at = new Attempts(2);
    at.begin("RC-1"); // a wrong password, still being verified
    const right = at.begin("RC-1"); // a correct one, in flight beside it
    expect(at.isLocked("RC-1")).toBe(true); // two attempts, a budget of two
    at.release("RC-1", right);
    expect(at.isLocked("RC-1")).toBe(false); // the correct one gave its slot back
    expect(at.size).toBe(1); // the wrong one kept its own
  });
  it("drops keys whose window has gone quiet", () => {
    const at = new Attempts(5, 10);
    at.begin("gone");
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

  it("deletes in batches until there is nothing left to delete", async () => {
    // Same reason as the idempotency sweep: a table nothing else ever deletes from carries every
    // sign-in the hospital has performed, so the first run after this ships is the big one. It
    // goes a bounded batch at a time. Five dead rows, two at a time, proves the loop.
    const dead = Array.from({ length: 5 }, () => ({
      id: randomUUID(), userId: "u1", family: randomUUID(),
      tokenHash: randomUUID(), expiresAt: new Date(Date.now() - 86400_000),
    }));
    await b.db.insert(refreshTokens).values(dead);
    const spy = vi.spyOn(b.db, "delete");
    try {
      expect(await purgeRefreshTokens(b.db, 2)).toBe(5);
      // 2 + 2 + 1 - the short last batch is what ends the loop.
      expect(spy.mock.calls.length).toBe(3);
    } finally { spy.mockRestore(); }
    const left = (await b.db.select().from(refreshTokens)).map((t) => t.tokenHash);
    expect(dead.filter((r) => left.includes(r.tokenHash))).toEqual([]);
  });
});
