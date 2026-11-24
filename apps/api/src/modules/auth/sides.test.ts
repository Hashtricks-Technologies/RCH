import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import type { AuditEvent, SwitchSideBody } from "@rch/contract";
import { ADMIN_PRESET, DESK_DEFAULTS } from "@rch/domain";
import type { App } from "../../app.js";
import { locations, refreshTokens, roles, shifts, users } from "../../db/schema/index.js";
import { buildTestApp } from "../../test/app.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { seedTestDb } from "../../test/seed.js";

/**
 * A two-sided role: one account that sells at any outlet (Billing) and does the store keeper's and
 * the buyer's work (Inventory). Every case signs in through the real route, so what is under test
 * is the session - the token, the cookie's row and the two together.
 */
let app: App;
let roleId: string;
let userId: string;
let emp: string;
const PW = "two-sided-password";

const asAdmin = async (method: InjectOptions["method"], url: string, payload: Record<string, unknown>) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { ...(await authHeaders(app, "u7")), "idempotency-key": randomUUID() }, payload });

beforeAll(async () => {
  app = await buildTestApp({ schema: "auth_sides", env: { LOGIN_RATE_LIMIT_PER_MINUTE: "500", LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE: "500" } });
  await seedTestDb(app.testDb!.db);
  await app.ready();
  const r = await asAdmin("POST", "/admin/roles", { name: "Admin", desk: ADMIN_PRESET.desk, perms: ADMIN_PRESET.perms, inventory: ADMIN_PRESET.inventory });
  expect(r.statusCode, r.body).toBe(200);
  roleId = r.json().result.id as string;
  const u = await asAdmin("POST", "/admin/users", { name: "Asha Admin", email: "asha@royalcare.in", roleId, loc: "coffee" });
  expect(u.statusCode, u.body).toBe(200);
  userId = u.json().result.id as string;
  emp = u.json().result.emp as string;
  const first = await login(u.json().result.tempPassword as string);
  expect(first.statusCode, first.body).toBe(200);
  // Asked to change the temporary password before anything else - the choice included.
  const early = await app.inject({ method: "POST", url: "/api/v1/auth/side", headers: bearer(first), cookies: { rch_refresh: cookieOf(first) }, payload: { side: "inventory" } });
  expect(early.json().error.message).toBe("Change your password before you carry on.");
  const changed = await app.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: bearer(first), payload: { current: u.json().result.tempPassword, next: PW } });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(changed.json().user.sides.at).toBeNull();
});
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  await app.db.update(roles).set({ perms: ADMIN_PRESET.perms, inventoryPerms: ADMIN_PRESET.inventory }).where(eq(roles.id, roleId));
  await app.db.update(users).set({ roleId, role: "counter", active: true }).where(eq(users.id, userId));
  await app.db.delete(shifts).where(eq(shifts.userId, userId));
  app.access.clear();
});

type Reply = Awaited<ReturnType<typeof login>>;
const login = (password = PW, loc?: string) => app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { emp, password, ...(loc ? { loc } : {}) } });
const cookieOf = (r: Reply) => r.cookies.find((c) => c.name === "rch_refresh")!.value;
const bearer = (r: Reply) => ({ authorization: `Bearer ${r.json().accessToken as string}` });
const claims = (r: Reply) => app.jwt.decode(r.json().accessToken as string) as { role: string; loc: string; unplaced?: boolean };
const refresh = (cookie: string) => app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: cookie } });
const choose = (from: Reply, cookie: string, body: SwitchSideBody) =>
  app.inject({ method: "POST", url: "/api/v1/auth/side", headers: bearer(from), cookies: { rch_refresh: cookie }, payload: body });
/** Signed in and standing somewhere: the reply of the choice, and the session's cookie. */
const standing = async (body: SwitchSideBody) => {
  const s = await login();
  expect(s.statusCode, s.body).toBe(200);
  const r = await choose(s, cookieOf(s), body);
  expect(r.statusCode, r.body).toBe(200);
  return { reply: r, cookie: cookieOf(s) };
};
const send = (as: Reply, method: InjectOptions["method"], url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { ...bearer(as), ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) }, ...(payload ? { payload } : {}) });
const sale = (as: Reply, loc: string) => send(as, "POST", "/bills", { loc, tender: "Cash", lines: [{ it: "water", qty: 1 }] });
const openShifts = () => app.db.select().from(shifts).where(and(eq(shifts.userId, userId), isNull(shifts.closedAt)));
const events = async (action: string): Promise<AuditEvent[]> => {
  await app.auditSettled();
  const r = await app.testDb!.pool.query<{ event: AuditEvent }>("select event from audit_outbox where event->>'action' = $1 order by id", [action]);
  return r.rows.map((x) => x.event);
};

describe("signing in", () => {
  it("leaves the session without a side, offering every open outlet, and opens no shift", async () => {
    const r = await login();
    expect(r.json().user.sides).toEqual({ at: null, outlets: [
      { k: "coffee", n: "Coffee Shop", c: expect.any(String) }, { k: "rest", n: "Restaurant", c: expect.any(String) }, { k: "kiosk", n: "Snack Kiosk", c: expect.any(String) },
    ] });
    expect(claims(r)).toMatchObject({ role: "counter", loc: "coffee", unplaced: true });
    expect(await openShifts()).toEqual([]);
  });

  it("reaches nothing operational until a side is chosen - reads, writes and the change stream", async () => {
    const r = await login();
    for (const [method, url] of [["GET", "/snapshot"], ["GET", "/stock"], ["GET", "/events"], ["POST", "/requests"]] as const) {
      const x = await send(r, method, url, method === "POST" ? { lines: [{ it: "butter", qty: 1 }], note: "", urgent: false } : undefined);
      expect(x.statusCode, `${method} ${url} ${x.body}`).toBe(403);
      expect(x.json().error.message).toBe("Choose Billing or Inventory before you carry on.");
    }
    expect((await sale(r, "coffee")).statusCode).toBe(403);
    // Who am I is how the browser finds out it has to ask.
    const me = await send(r, "GET", "/me");
    expect(me.statusCode).toBe(200);
    expect(me.json().user.sides.at).toBeNull();
  });

  it("stays unplaced across a refresh", async () => {
    const r = await refresh(cookieOf(await login()));
    expect(r.json().user.sides.at).toBeNull();
    expect(claims(r).unplaced).toBe(true);
  });

  it("is Billing there when the sign-in names a counter", async () => {
    const r = await login(PW, "kiosk");
    expect(r.json().user).toMatchObject({ r: "counter", loc: "kiosk", sides: { at: "billing" } });
    expect((await openShifts()).map((s) => s.loc)).toEqual(["kiosk"]);
  });

  it("is on the public directory with its home alone, however many counters it is posted to", async () => {
    await asAdmin("PUT", `/admin/users/${userId}/postings`, { locs: ["coffee", "kiosk"] });
    const dir = (await app.inject({ method: "GET", url: "/api/v1/auth/directory" })).json() as Array<{ emp: string; locs: Array<{ k: string }> }>;
    expect(dir.find((e) => e.emp === emp)?.locs.map((l) => l.k)).toEqual(["coffee"]);
    await asAdmin("PUT", `/admin/users/${userId}/postings`, { locs: ["coffee"] });
  });
});

describe("the Billing side", () => {
  it("bills at each outlet it stands at, and only there", async () => {
    for (const loc of ["coffee", "kiosk", "rest"]) {
      const { reply } = await standing({ side: "billing", loc });
      expect(reply.json().user).toMatchObject({ r: "counter", loc, perms: ADMIN_PRESET.perms, sides: { at: "billing" } });
      expect(claims(reply).unplaced).toBeUndefined();
      const r = await sale(reply, loc);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().result.loc).toBe(loc);
      const elsewhere = await sale(reply, loc === "coffee" ? "kiosk" : "coffee");
      expect(elsewhere.statusCode).toBe(403);
    }
  });

  it("raises a stock request from the outlet it stands at, and approves it", async () => {
    const { reply } = await standing({ side: "billing", loc: "kiosk" });
    const made = await send(reply, "POST", "/requests", { lines: [{ it: "butter", qty: 1 }], note: "", urgent: false });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().result.from).toBe("kiosk");
    const ok = await send(reply, "POST", `/requests/${made.json().result.id as string}/approve`, { appr: [1], note: "" });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("reads every outlet, takes a Z, and has no central-store or admin doors", async () => {
    const { reply } = await standing({ side: "billing", loc: "rest" });
    await sale(reply, "rest");
    const snap = await send(reply, "GET", "/snapshot");
    expect(snap.statusCode).toBe(200);
    expect(snap.json().user).toMatchObject({ r: "counter", loc: "rest", sides: { at: "billing" } });
    const z = await send(reply, "POST", "/register/close", { loc: "rest" });
    expect(z.statusCode, z.body).toBe(200);
    expect((await send(reply, "POST", "/requests/REQ-2026-0909/issue-ticket")).statusCode).toBe(404);
    expect((await send(reply, "GET", "/admin/users")).statusCode).toBe(404);
  });

  it("may not void its own bill", async () => {
    const { reply } = await standing({ side: "billing", loc: "kiosk" });
    const no = (await sale(reply, "kiosk")).json().result.no as string;
    const r = await send(reply, "POST", `/bills/${encodeURIComponent(no)}/void`, { reason: "Keyed twice" });
    expect(r.statusCode, r.body).toBe(403);
  });
});

describe("the Inventory side", () => {
  it("stands at the central store with its own permissions, and does the store's and the buyer's work", async () => {
    const { reply } = await standing({ side: "inventory" });
    expect(reply.json().user).toMatchObject({ r: "store", loc: "store", perms: ADMIN_PRESET.inventory, sides: { at: "inventory" } });
    expect((await send(reply, "GET", "/me")).json().user).toMatchObject({ r: "store", loc: "store" });
    expect((await send(reply, "PATCH", "/me", { ph: "90000 00001" })).json().user).toMatchObject({ r: "store", loc: "store" });
    // The store: issue an approved request's ticket and hand it over.
    const req = await given.request(app.db, { from: "kiosk", by: userId, lines: [{ it: "butter", qty: 1, appr: 1 }], st: "Manager approved" });
    const ticket = await send(reply, "POST", `/requests/${req}/issue-ticket`);
    expect(ticket.statusCode, ticket.body).toBe(200);
    // Purchasing: a vendor, and goods in against an order.
    const vendor = await send(reply, "POST", "/vendors", { n: `Vendor ${randomUUID().slice(0, 6)}`, gstin: "33AAACA1234F1Z5", contact: "Kumar S", ph: "98430 11220", terms: "30 days", lead: 2, groups: ["Grocery"] });
    expect(vendor.statusCode, vendor.body).toBe(200);
    const adj = await send(reply, "POST", "/adjustments", { loc: "store", reason: "wastage", note: "Dropped tray", lines: [{ it: "milk", qty: -1 }] });
    expect(adj.statusCode, adj.body).toBe(200);
  });

  it("has no till: no sale, no stock request, no shift", async () => {
    const { reply } = await standing({ side: "inventory" });
    expect((await sale(reply, "coffee")).statusCode).toBe(404);
    expect((await send(reply, "POST", "/requests", { lines: [{ it: "butter", qty: 1 }], note: "", urgent: false })).statusCode).toBe(404);
    expect((await send(reply, "GET", "/shifts/current")).statusCode).toBe(404);
    expect(await openShifts()).toEqual([]);
  });
});

describe("switching", () => {
  it("moves the one session, and its place survives two silent refreshes", async () => {
    const { reply, cookie } = await standing({ side: "billing", loc: "coffee" });
    const moved = await choose(reply, cookie, { side: "inventory" });
    expect(claims(moved)).toMatchObject({ role: "store", loc: "store" });
    let c = cookie;
    for (const _ of [1, 2]) {
      const r = await refresh(c);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().user).toMatchObject({ r: "store", loc: "store", sides: { at: "inventory" } });
      c = cookieOf(r);
    }
    // Another sign-in of the same account stands where it always did.
    const other = await standing({ side: "billing", loc: "kiosk" });
    expect((await refresh(c)).json().user.loc).toBe("store");
    expect((await refresh(other.cookie)).json().user.loc).toBe("kiosk");
  });

  it("closes the shift left behind, keeps one at the same till, and closes it for the central store", async () => {
    const { reply, cookie } = await standing({ side: "billing", loc: "coffee" });
    const [first] = await openShifts();
    expect(first.loc).toBe("coffee");
    await choose(reply, cookie, { side: "billing", loc: "coffee" });
    expect((await openShifts()).map((s) => s.id)).toEqual([first.id]);
    await choose(reply, cookie, { side: "billing", loc: "kiosk" });
    expect((await openShifts()).map((s) => s.loc)).toEqual(["kiosk"]);
    await choose(reply, cookie, { side: "inventory" });
    expect(await openShifts()).toEqual([]);
    const all = await app.db.select().from(shifts).where(eq(shifts.userId, userId)).orderBy(asc(shifts.openedAt));
    expect(all.map((s) => [s.loc, (s.closedTotals as { auto: boolean }).auto])).toEqual([["coffee", true], ["kiosk", true]]);
  });

  it("refuses a closed outlet, a place that is not one, and one the hospital does not have - and moves nothing", async () => {
    const { reply, cookie } = await standing({ side: "billing", loc: "coffee" });
    await app.db.update(locations).set({ active: false }).where(eq(locations.key, "kiosk"));
    try {
      const shut = await choose(reply, cookie, { side: "billing", loc: "kiosk" });
      expect(shut.statusCode).toBe(422);
      expect(shut.json().error.message).toContain("Snack Kiosk");
    } finally {
      await app.db.update(locations).set({ active: true }).where(eq(locations.key, "kiosk"));
    }
    const store = await choose(reply, cookie, { side: "billing", loc: "store" });
    expect(store.statusCode).toBe(422);
    expect(store.json().error.message).toBe("You are not posted to Central Store.");
    expect((await choose(reply, cookie, { side: "billing", loc: "nowhere" })).statusCode).toBe(404);
    expect((await choose(reply, cookie, { side: "billing" } as never)).statusCode).toBe(400);
    expect((await refresh(cookie)).json().user.loc).toBe("coffee");
  });

  it("without every outlet, stands only where it is posted", async () => {
    await app.db.update(roles).set({ perms: { f: ADMIN_PRESET.perms.f, a: [] } }).where(eq(roles.id, roleId));
    app.access.clear();
    const s = await login();
    expect(s.json().user.sides.outlets.map((o: { k: string }) => o.k)).toEqual(["coffee"]);
    const r = await choose(s, cookieOf(s), { side: "billing", loc: "kiosk" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("You are not posted to Snack Kiosk.");
  });

  it("does not exist for an ordinary role", async () => {
    const s = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { emp: "RC-4482", password: "changeme" } });
    expect(s.json().user.sides).toBeUndefined();
    expect(claims(s).unplaced).toBeUndefined();
    const r = await choose(s, cookieOf(s), { side: "inventory" });
    expect(r.statusCode).toBe(404);
  });

  it("is a 401 with no cookie, somebody else's, or one already rotated or revoked", async () => {
    const s = await login();
    const none = await app.inject({ method: "POST", url: "/api/v1/auth/side", headers: bearer(s), payload: { side: "inventory" } });
    expect(none.statusCode).toBe(401);
    const other = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { emp: "RC-4482", password: "changeme" } });
    expect((await choose(s, cookieOf(other), { side: "inventory" })).statusCode).toBe(401);
    expect((await refresh(cookieOf(other))).json().user).toMatchObject({ r: "counter", loc: "kiosk" });
    const rotated = await refresh(cookieOf(s));
    expect((await choose(s, cookieOf(s), { side: "inventory" })).statusCode).toBe(401);
    await app.inject({ method: "POST", url: "/api/v1/auth/logout", cookies: { rch_refresh: cookieOf(rotated) } });
    expect((await choose(s, cookieOf(rotated), { side: "inventory" })).statusCode).toBe(401);
  });

  it("is not lost to a refresh that read the row before the switch committed", async () => {
    const { cookie } = await standing({ side: "billing", loc: "coffee" });
    const hash = createHash("sha256").update(cookie).digest("hex");
    const client = await app.testDb!.pool.connect();
    try {
      // A switch, held open: the refresh reads the row as it stood, then waits on its lock to claim it.
      await client.query("begin");
      await client.query("select 1 from refresh_tokens where token_hash = $1 for update", [hash]);
      const racing = refresh(cookie);
      await expect.poll(async () => (await app.testDb!.pool.query("select 1 from pg_locks where not granted")).rowCount).toBeGreaterThan(0);
      await client.query("update refresh_tokens set desk = 'store', loc = 'store' where token_hash = $1", [hash]);
      await client.query("commit");
      const r = await racing;
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().user).toMatchObject({ r: "store", loc: "store" });
    } finally {
      client.release();
    }
  });

  it("a password change keeps the session where it stands", async () => {
    const { reply } = await standing({ side: "inventory" });
    const next = "another-long-password";
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: bearer(reply), payload: { current: PW, next } });
    expect(r.json().user).toMatchObject({ r: "store", loc: "store", sides: { at: "inventory" } });
    await app.inject({ method: "POST", url: "/api/v1/auth/change-password", headers: bearer(r), payload: { current: next, next: PW } });
  });
});

describe("a role changed under a live session", () => {
  it("sends an Inventory session home when the side is taken away", async () => {
    const { reply, cookie } = await standing({ side: "inventory" });
    const off = await asAdmin("PATCH", `/admin/roles/${roleId}`, { inventory: null });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().result.inventory).toBeUndefined();
    expect(off.json().message).toContain("takes effect for its 1 holder");
    expect((await send(reply, "GET", "/snapshot")).statusCode).toBe(401);
    const r = await refresh(cookie);
    expect(r.json().user).toMatchObject({ r: "counter", loc: "coffee" });
    expect(r.json().user.sides).toBeUndefined();
    expect((await send(r, "GET", "/snapshot")).statusCode).toBe(200);
  });

  it("sends an unplaced session on to its home counter, and one at an unposted till back to it", async () => {
    const fresh = await login();
    const { cookie } = await standing({ side: "billing", loc: "kiosk" });
    await app.db.update(roles).set({ inventoryPerms: null }).where(eq(roles.id, roleId));
    app.access.clear();
    expect((await send(fresh, "GET", "/snapshot")).statusCode).toBe(401);
    expect(claims(await refresh(cookieOf(fresh)))).toMatchObject({ role: "counter", loc: "coffee" });
    expect(claims(await refresh(cookie))).toMatchObject({ role: "counter", loc: "coffee" });
  });

  it("asks again when the outlet it stood at has closed", async () => {
    const { cookie } = await standing({ side: "billing", loc: "kiosk" });
    await app.db.update(locations).set({ active: false }).where(eq(locations.key, "kiosk"));
    try {
      const r = await refresh(cookie);
      expect(r.json().user.sides.at).toBeNull();
      expect(r.json().user.sides.outlets.map((o: { k: string }) => o.k)).not.toContain("kiosk");
    } finally {
      await app.db.update(locations).set({ active: true }).where(eq(locations.key, "kiosk"));
    }
  });

  it("is refused for a deactivated account", async () => {
    const s = await login();
    await app.db.update(users).set({ active: false }).where(eq(users.id, userId));
    app.access.clear();
    expect((await choose(s, cookieOf(s), { side: "inventory" })).statusCode).toBe(401);
  });
});

describe("the role itself", () => {
  it("takes an Inventory side on the counter desk alone, within the store desk's limits", async () => {
    const r = await asAdmin("POST", "/admin/roles", { name: "Bad side", desk: "manager", perms: DESK_DEFAULTS.manager.perms, inventory: ADMIN_PRESET.inventory });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Only a role on the counter desk can have an Inventory side - this one works at the outlet manager desk.");
    const till = await asAdmin("PATCH", `/admin/roles/${roleId}`, { inventory: { f: { billing: "edit" }, a: [] } });
    expect(till.statusCode).toBe(422);
    expect(till.json().error.message).toBe("The store desk can't be given edit access to Bills.");
    const same = await asAdmin("PATCH", `/admin/roles/${roleId}`, { inventory: ADMIN_PRESET.inventory });
    expect(same.statusCode).toBe(422);
    const list = await app.inject({ method: "GET", url: "/api/v1/admin/roles", headers: await authHeaders(app, "u7") });
    const rows = list.json() as Array<{ id: string; inventory?: unknown }>;
    expect(rows.find((x) => x.id === roleId)?.inventory).toEqual(ADMIN_PRESET.inventory);
    expect(rows.find((x) => x.id === "ROLE-001")).not.toHaveProperty("inventory");
  });
});

describe("the audit trail", () => {
  it("records one event per switch - where, and no token - and one per refusal", async () => {
    const s = await login();
    const before = (await events("switchSide")).length;
    await choose(s, cookieOf(s), { side: "billing", loc: "kiosk" });
    await choose(s, cookieOf(s), { side: "inventory" });
    await choose(s, cookieOf(s), { side: "billing", loc: "store" });
    await app.inject({ method: "POST", url: "/api/v1/auth/side", headers: bearer(s), payload: { side: "inventory" } });   // a 401 is not an event
    const made = (await events("switchSide")).slice(before);
    expect(made.map((e) => [e.outcome, e.message, e.targetLoc, e.actor.loc])).toEqual([
      ["done", "Working Billing at Snack Kiosk", "kiosk", "kiosk"],
      ["done", "Working Inventory at the Central Store", "store", "store"],
      ["refused", "You are not posted to Central Store.", "store", "coffee"],
    ]);
    expect(JSON.stringify(made)).not.toContain(cookieOf(s));
    expect(JSON.stringify(made)).not.toMatch(/eyJ/);
  });

  it("names the place the work was done, not the account's home", async () => {
    const { reply } = await standing({ side: "inventory" });
    await send(reply, "POST", "/adjustments", { loc: "store", reason: "wastage", note: "Split bag", lines: [{ it: "milk", qty: -1 }] });
    expect((await events("createAdjustment")).at(-1)?.actor).toMatchObject({ emp, role: "Admin", loc: "store" });
  });

  it("stores the desk on the refresh row, and nothing while the choice is open", async () => {
    const s = await login();
    const row = async () => (await app.db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, createHash("sha256").update(cookieOf(s)).digest("hex"))))[0];
    expect((await row()).desk).toBeNull();
    await choose(s, cookieOf(s), { side: "inventory" });
    expect(await row()).toMatchObject({ desk: "store", loc: "store" });
  });
});
