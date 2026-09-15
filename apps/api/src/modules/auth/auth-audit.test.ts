import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { AuditEvent } from "@rch/contract";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import type { App } from "../../app.js";
import { users } from "../../db/schema/index.js";

/**
 * Sign-in events (spec §2.6). The auth routes are public or `write: false`, so `mount()` never
 * records them; the auth module does, one event per attempt.
 *
 * Two apps, like auth.test.ts. `a` raises the per-IP login budget out of reach, so only the
 * per-employee counter can refuse there; `b` keeps a per-IP budget of two, for the limiter's own
 * refusal. Each case signs in as a different seeded account, so a password changed or an id
 * locked in one case never reaches another.
 */
let a: App;
let b: App;
beforeAll(async () => {
  a = await buildTestApp({ schema: "auth_audit", env: { LOGIN_RATE_LIMIT_PER_MINUTE: "100" } });
  await seedTestDb(a.testDb!.db);
  await a.ready();
  b = await buildTestApp({ schema: "auth_audit_ip", env: { LOGIN_RATE_LIMIT_PER_MINUTE: "2" } });
  await seedTestDb(b.testDb!.db);
  await b.ready();
});
afterAll(async () => {
  await a.close();
  await b.close();
});

const login = (app: App, emp: string, password = "changeme") =>
  app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { emp, password } });
const cookieOf = (r: { cookies: Array<{ name: string; value: string }> }) => r.cookies.find((c) => c.name === "rch_refresh")!.value;
/** Outbox events, oldest first - all of them, or one action's. Read straight off the table, which
 *  only a test may do (scripts/check-boundaries.sh). Every sign-in event here is stored before its
 *  reply leaves, but a read of refusals waits on `auditSettled` all the same (D16), so nothing
 *  `plugins/audit.ts` is still storing can be missed. */
const events = async (app: App, action?: string): Promise<AuditEvent[]> => {
  await app.auditSettled();
  const r = action === undefined
    ? await app.testDb!.pool.query<{ event: AuditEvent }>("select event from audit_outbox order by id")
    : await app.testDb!.pool.query<{ event: AuditEvent }>("select event from audit_outbox where event->>'action' = $1 order by id", [action]);
  return r.rows.map((row) => row.event);
};
const last = async (app: App, action: string): Promise<AuditEvent> => {
  const all = await events(app, action);
  expect(all.length, `no ${action} event in the outbox`).toBeGreaterThan(0);
  return all.at(-1)!;
};

describe("sign-in events", () => {
  it("records a correct sign-in against the account", async () => {
    expect((await login(a, "RC-4471")).statusCode).toBe(200);
    expect(await last(a, "login")).toMatchObject({
      action: "login", outcome: "done", status: 200, message: "Signed in", cause: null,
      actor: { id: "u1", emp: "RC-4471", name: "Kavitha Raman" },
    });
  });

  it("records a wrong password against the account it named, with the cause the log line carries", async () => {
    const r = await login(a, "RC-3120", "nope");
    expect(r.statusCode).toBe(401);
    expect(await last(a, "login")).toMatchObject({
      outcome: "refused", status: 401, message: r.json().error.message, cause: "wrong password for RC-3120",
      actor: { id: "u2", emp: "RC-3120" },
    });
  });

  it("records a deactivated account's attempt against that account", async () => {
    await a.db.update(users).set({ active: false }).where(eq(users.id, "u6"));
    try {
      expect((await login(a, "RC-4482")).statusCode).toBe(401);
      expect(await last(a, "login")).toMatchObject({ outcome: "refused", status: 401, cause: "RC-4482 is deactivated", actor: { id: "u6", emp: "RC-4482" } });
    } finally {
      await a.db.update(users).set({ active: true }).where(eq(users.id, "u6"));
    }
  });

  it("records an unknown employee id with no account and the id that was typed", async () => {
    expect((await login(a, "RC-0000")).statusCode).toBe(401);
    expect(await last(a, "login")).toMatchObject({ outcome: "refused", status: 401, cause: "no such employee", actor: { id: null, emp: "RC-0000", name: "" } });
  });

  it("keeps nothing of a typed id that is not shaped like an employee number - it may have been the password", async () => {
    expect((await login(a, "hunter2 in the wrong box")).statusCode).toBe(401);
    expect(await last(a, "login")).toMatchObject({ outcome: "refused", cause: "no such employee", actor: { id: null, emp: "" } });
    expect(JSON.stringify(await events(a))).not.toContain("hunter2");
  });

  it("records the per-employee lockout", async () => {
    for (let i = 0; i < 5; i++) expect((await login(a, "RC-9998", "guess")).statusCode).toBe(401);
    const r = await login(a, "RC-9998", "guess");
    expect(r.statusCode).toBe(429);
    expect(await last(a, "login")).toMatchObject({
      outcome: "refused", status: 429, message: r.json().error.message,
      cause: "too many attempts for this employee id", actor: { id: null, emp: "RC-9998" },
    });
  });

  it("records the per-IP limiter's refusal, which the login handler never sees", async () => {
    expect((await login(b, "RC-4471", "wrong-1")).statusCode).toBe(401);
    expect((await login(b, "RC-4471", "wrong-2")).statusCode).toBe(401);
    const limited = await login(b, "RC-4471", "wrong-3");
    expect(limited.statusCode).toBe(429);
    const all = await events(b, "login");
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({
      outcome: "refused", status: 429, message: limited.json().error.message,
      cause: "per-IP sign-in limit", actor: { id: null, emp: "RC-4471" },
    });
  });
});

describe("sign-out and password events", () => {
  it("records a sign-out against the session's account, and nothing for a logout that ended no session", async () => {
    const cookie = cookieOf(await login(a, "RC-1902"));
    const before = (await events(a, "logout")).length;
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { rch_refresh: cookie } })).statusCode).toBe(200);
    // The same cookie again: the family is already revoked, so nobody is signed out.
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { rch_refresh: cookie } })).statusCode).toBe(200);
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/logout" })).statusCode).toBe(200);
    const after = await events(a, "logout");
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ outcome: "done", status: 200, message: "Signed out", actor: { id: "u4", emp: "RC-1902" } });
  });

  it("records a password change, and each refusal of one, against the account - one event each", async () => {
    const l = await login(a, "RC-1550");
    const change = (token: string, current: string, next: string) => a.inject({
      method: "POST", url: "/api/v1/auth/change-password", headers: { authorization: `Bearer ${token}` }, payload: { current, next },
    });
    const before = (await events(a, "changePassword")).length;

    expect((await change(l.json().accessToken, "wrong", "a-much-longer-secret-5")).statusCode).toBe(401);
    expect(await last(a, "changePassword")).toMatchObject({ outcome: "refused", status: 401, cause: "wrong current password", actor: { id: "u5" } });

    const ok = await change(l.json().accessToken, "changeme", "a-much-longer-secret-5");
    expect(ok.statusCode).toBe(200);
    expect(await last(a, "changePassword")).toMatchObject({ outcome: "done", status: 200, message: "Password changed - every other session was signed out", actor: { id: "u5", emp: "RC-1550" } });

    const same = await change(ok.json().accessToken, "a-much-longer-secret-5", "a-much-longer-secret-5");
    expect(same.statusCode).toBe(422);
    expect(await last(a, "changePassword")).toMatchObject({ outcome: "refused", status: 422, message: "Choose a different password from your current one.", actor: { id: "u5" } });

    expect(await events(a, "changePassword")).toHaveLength(before + 3);
  });

  it("never stores a password, a new password, a refresh token or an access token", async () => {
    const l = await login(a, "RC-2088");
    const firstCookie = cookieOf(l);
    const firstToken = l.json().accessToken as string;
    expect((await login(a, "RC-2088", "typed-wrong-secret-7")).statusCode).toBe(401);
    const cp = await a.inject({
      method: "POST", url: "/api/v1/auth/change-password", headers: { authorization: `Bearer ${firstToken}` },
      payload: { current: "changeme", next: "brand-new-secret-8" },
    });
    expect(cp.statusCode).toBe(200);
    const freshCookie = cookieOf(cp);
    expect((await a.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { rch_refresh: freshCookie } })).statusCode).toBe(200);

    const stored = JSON.stringify(await events(a));
    for (const secret of ["changeme", "typed-wrong-secret-7", "brand-new-secret-8", firstCookie, freshCookie, firstToken, cp.json().accessToken as string]) {
      expect(stored).not.toContain(secret);
    }
  });
});
