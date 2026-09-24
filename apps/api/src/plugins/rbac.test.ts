import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { act, anyOf, defineRoute, desk, need, type Permissions } from "@rch/contract";
import { DESK_DEFAULTS, permissionRefusal } from "@rch/domain";
import type { App } from "../app.js";
import { buildTestApp } from "../test/app.js";
import { authHeaders } from "../test/auth.js";
import { seedTestDb } from "../test/seed.js";
import { mount } from "../routes.js";
import { roles, users } from "../db/schema/index.js";
import { withTransaction } from "../lib/db.js";
import { emitChanged } from "../lib/events.js";

/**
 * The gate, against routes mounted for the test alone - no manifest route asks for a permission
 * yet, so the `{ needs }` and `{ desk }` forms are proved here, through the real `mount()`, the real
 * permission cache and the real change stream.
 */
let app: App;
const Actor = z.object({ sub: z.string(), wide: z.boolean(), perms: z.unknown() });
beforeAll(async () => {
  app = await buildTestApp({ schema: "rbac" });
  await seedTestDb(app.testDb!.db);
  const reply = async (req: { actor: z.infer<typeof Actor> }) => ({ sub: req.actor.sub, wide: req.actor.wide, perms: req.actor.perms });
  mount(app, defineRoute({ method: "GET", path: "/_test/any", access: "any", response: Actor }), reply);
  mount(app, defineRoute({ method: "GET", path: "/_test/admitted", access: "any", admitAdmin: true, response: Actor }), reply);
  mount(app, defineRoute({ method: "GET", path: "/_test/prices", access: need("prices", "edit"), response: Actor }), reply);
  mount(app, defineRoute({ method: "GET", path: "/_test/void", access: act("void_bill"), response: Actor }), reply);
  mount(app, defineRoute({ method: "GET", path: "/_test/move", access: anyOf(need("items_stock", "edit"), need("outlet_tickets", "edit")), response: Actor }), reply);
  mount(app, defineRoute({ method: "GET", path: "/_test/desk", access: desk("counter"), response: Actor }), reply);
  await app.ready();
});
afterAll(async () => { await app.close(); });

const get = async (path: string, headers: Record<string, string>) => app.inject({ method: "GET", url: `/api/v1/_test/${path}`, headers });
const admin = (method: "POST" | "PATCH", url: string, payload?: Record<string, unknown>) =>
  authHeaders(app, "u7").then((h) => app.inject({ method, url: `/api/v1${url}`, headers: { ...h, "idempotency-key": randomUUID() }, ...(payload ? { payload } : {}) }));
/** A role of the test's own on a desk, given to one seeded account by hand - the account write's
 *  own rules are the admin suite's business, not this one's. */
const giveRole = async (userId: string, deskOf: "counter" | "manager", perms: Permissions): Promise<string> => {
  const r = await admin("POST", "/admin/roles", { name: `Gate ${randomUUID().slice(0, 8)}`, desk: deskOf, perms });
  expect(r.statusCode, r.body).toBe(200);
  const id = r.json().result.id as string;
  await app.db.update(users).set({ roleId: id }).where(eq(users.id, userId));
  app.access.clear();
  return id;
};

describe("the super admin", () => {
  it("is a 404 on an operational route, and admitted only where the route says so, past every permission", async () => {
    const h = await authHeaders(app, "u7");
    expect((await get("any", h)).statusCode).toBe(404);
    expect((await get("prices", h)).statusCode).toBe(404);
    const r = await get("admitted", h);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ sub: "u7", wide: true, perms: { f: {}, a: [] } });
  });
});

describe("the account behind the token", () => {
  it("sets the caller's permissions on the request, read from its role", async () => {
    const r = await get("any", await authHeaders(app, "u2"));
    expect(r.json()).toEqual({ sub: "u2", wide: true, perms: DESK_DEFAULTS.manager.perms });
    const c = await get("any", await authHeaders(app, "u1"));
    expect(c.json()).toEqual({ sub: "u1", wide: false, perms: DESK_DEFAULTS.counter.perms });
  });
  it("is a 401 when the token's desk is not the account's any more", async () => {
    const token = await app.signAccess({ id: "u1", role: "manager", loc: "coffee", mcp: false, admin: false });
    const r = await get("any", { authorization: `Bearer ${token}` });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toBe("Your account was changed - sign in again.");
  });
  it("is a 401 for a token whose account holds no role at all", async () => {
    const token = await app.signAccess({ id: "u404", role: "counter", loc: "coffee", mcp: false, admin: false });
    expect((await get("any", { authorization: `Bearer ${token}` })).statusCode).toBe(401);
  });
  it("is a 401 on the very next request once the account moves to another desk", async () => {
    const h = await authHeaders(app, "u6");
    expect((await get("any", h)).statusCode).toBe(200);
    const moved = await admin("PATCH", "/admin/users/u6", { roleId: "ROLE-003", loc: "store" });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await get("any", h)).statusCode).toBe(401);
    // and back, so the rest of the file finds the seed as it was
    expect((await admin("PATCH", "/admin/users/u6", { roleId: "ROLE-001", loc: "kiosk" })).statusCode).toBe(200);
  });
  it("is a 401 once the role the token's account holds is switched off", async () => {
    const id = await giveRole("u6", "counter", { f: { billing: "edit" }, a: [] });
    const h = await authHeaders(app, "u6");
    expect((await get("any", h)).statusCode).toBe(200);
    // A role is switched off only once nobody active holds it; the token outlives the account.
    await app.db.update(users).set({ active: false }).where(eq(users.id, "u6"));
    expect((await admin("POST", `/admin/roles/${id}/deactivate`)).statusCode).toBe(200);
    expect((await get("any", h)).statusCode).toBe(401);
    await app.db.update(users).set({ active: true, roleId: "ROLE-001" }).where(eq(users.id, "u6"));
    app.access.clear();
  });
});

describe("a route that needs a permission", () => {
  it("is a 404 to a role that holds nothing of it, and a 403 in words to one that can only see it", async () => {
    expect((await get("prices", await authHeaders(app, "u1"))).statusCode).toBe(404);
    const viewer = await giveRole("u2", "manager", { f: { prices: "view", billing: "view" }, a: [] });
    const h = await authHeaders(app, "u2");
    const r = await get("prices", h);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe(permissionRefusal("prices"));
    // An action whose parent feature is held but the action is not.
    const v = await get("void", h);
    expect(v.statusCode).toBe(403);
    expect(v.json().error.message).toBe("You can see Bills but not void one - ask the administrator for the void permission.");

    // The same token, the role changed under it: the next request has the new answer.
    const patched = await admin("PATCH", `/admin/roles/${viewer}`, { perms: { f: { prices: "edit", billing: "view" }, a: ["void_bill"] } });
    expect(patched.statusCode, patched.body).toBe(200);
    const now = await get("prices", h);
    expect(now.statusCode, now.body).toBe(200);
    expect(now.json().wide).toBe(true);
    expect((await get("void", h)).statusCode).toBe(200);
    await app.db.update(users).set({ roleId: "ROLE-002" }).where(eq(users.id, "u2"));
    app.access.clear();
  });
  it("runs at the caller's own location when the need it met is a local one", async () => {
    const r = await get("move", await authHeaders(app, "u1"));
    expect(r.statusCode).toBe(200);
    expect(r.json().wide).toBe(false);
    const m = await get("move", await authHeaders(app, "u2"));
    expect(m.json().wide).toBe(true);
  });
  it("a desk route reads the desk alone", async () => {
    expect((await get("desk", await authHeaders(app, "u1"))).statusCode).toBe(200);
    expect((await get("desk", await authHeaders(app, "u2"))).statusCode).toBe(404);
  });
});

describe("the permission cache and the change stream", () => {
  it("keeps a role it has read until a roles notice arrives, from whichever pod", async () => {
    const h = await authHeaders(app, "u1");
    expect((await get("prices", h)).statusCode).toBe(404);
    // Changed behind the cache's back - no service, no local clear. This pod still answers from
    // what it read...
    await app.db.update(roles).set({ perms: { ...DESK_DEFAULTS.counter.perms, f: { ...DESK_DEFAULTS.counter.perms.f, prices: "edit" } } }).where(eq(roles.id, "ROLE-001"));
    expect((await get("prices", h)).statusCode).toBe(404);
    // ...until another pod's write announces it.
    await withTransaction(app.db, (tx) => emitChanged(tx, ["roles"]));
    await expect.poll(async () => (await get("prices", h)).statusCode, { timeout: 5000 }).toBe(200);
    await app.db.update(roles).set({ perms: DESK_DEFAULTS.counter.perms }).where(eq(roles.id, "ROLE-001"));
    app.access.clear();
  });
  it("is not emptied by a notice about something else", async () => {
    const h = await authHeaders(app, "u1");
    expect((await get("prices", h)).statusCode).toBe(404);
    await app.db.update(roles).set({ perms: { ...DESK_DEFAULTS.counter.perms, f: { ...DESK_DEFAULTS.counter.perms.f, prices: "edit" } } }).where(eq(roles.id, "ROLE-001"));
    await withTransaction(app.db, (tx) => emitChanged(tx, ["stock"]));
    await new Promise((r) => { setTimeout(r, 300); });
    expect((await get("prices", h)).statusCode).toBe(404);
    await app.db.update(roles).set({ perms: DESK_DEFAULTS.counter.perms }).where(eq(roles.id, "ROLE-001"));
    app.access.clear();
  });
});
