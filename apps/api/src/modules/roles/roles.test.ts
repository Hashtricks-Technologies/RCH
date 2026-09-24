import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import type { AdminRole, Permissions } from "@rch/contract";
import { DESK_DEFAULTS } from "@rch/domain";
import type { App } from "../../app.js";
import { buildTestApp } from "../../test/app.js";
import { authHeaders } from "../../test/auth.js";
import { seedTestDb } from "../../test/seed.js";
import { adminActions, roles, users } from "../../db/schema/index.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "roles" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

/** u7 (RC-0001) is the seed's super admin. */
const call = async (method: InjectOptions["method"], url: string, payload?: Record<string, unknown>, user = "u7") => {
  const headers = { ...(await authHeaders(app, user)), ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) };
  return app.inject({ method, url: `/api/v1${url}`, headers, ...(payload === undefined ? {} : { payload }) });
};
const ok = async (method: InjectOptions["method"], url: string, payload?: Record<string, unknown>) => {
  const r = await call(method, url, payload);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { result: AdminRole; changed: string[]; message: string };
};
const refused = async (status: number, method: InjectOptions["method"], url: string, payload?: Record<string, unknown>) => {
  const r = await call(method, url, payload);
  expect(r.statusCode, r.body).toBe(status);
  return r.json().error.message as string;
};
const list = async () => (await call("GET", "/admin/roles")).json() as AdminRole[];
const role = async (id: string) => (await list()).find((r) => r.id === id)!;

let n = 0;
/** A fresh role on a desk, never given to anybody. */
const fresh = async (desk: AdminRole["desk"] = "store", perms: Permissions = { f: { store_stock: "view" }, a: [] }) =>
  (await ok("POST", "/admin/roles", { name: `Probe ${++n} ${randomUUID().slice(0, 6)}`, desk, perms })).result;

describe("GET /admin/roles", () => {
  it("lists the five seeded roles with what each holds and how many active accounts hold it", async () => {
    const rows = await list();
    const byDesk = Object.fromEntries(rows.filter((r) => /^ROLE-00[1-5]$/.test(r.id)).map((r) => [r.desk, r]));
    for (const desk of ["counter", "manager", "store", "prod", "buyer"] as const) {
      expect(byDesk[desk]).toMatchObject({ name: DESK_DEFAULTS[desk].name, perms: DESK_DEFAULTS[desk].perms, active: true, everAssigned: true });
    }
    // Two counter operators in the demo hospital (RC-4471, RC-4482); the super admin holds none.
    expect(byDesk.counter.holders).toBe(2);
    expect(byDesk.manager.holders).toBe(1);
  });
  it("is the super admin's alone - a 404 for anybody else", async () => {
    expect((await call("GET", "/admin/roles", undefined, "u2")).statusCode).toBe(404);
  });
});

describe("POST /admin/roles", () => {
  it("creates a numbered role, logs it and announces roles", async () => {
    const perms: Permissions = { f: { billing: "edit", x_report: "view" }, a: [] };
    const r = await ok("POST", "/admin/roles", { name: "Relief Cashier", desk: "counter", perms });
    expect(r.result).toMatchObject({ name: "Relief Cashier", desk: "counter", perms, active: true, holders: 0, everAssigned: false });
    expect(r.result.id).toMatch(/^ROLE-\d{3,}$/);
    expect(r.changed).toEqual(["roles"]);
    expect(r.message).toBe(`Created the role Relief Cashier (${r.result.id}).`);
    const [line] = await app.db.select().from(adminActions).where(eq(adminActions.action, "role_create"));
    expect(line).toMatchObject({ actorId: "u7", targetId: null, targetName: "Relief Cashier", details: { id: r.result.id, desk: "counter" } });
    const [row] = await app.db.select().from(roles).where(eq(roles.id, r.result.id));
    expect(row.version).toBe(1);
  });
  it("refuses a name already in use, whatever its case", async () => {
    expect(await refused(409, "POST", "/admin/roles", { name: "counter operator", desk: "counter", perms: { f: {}, a: [] } }))
      .toBe("Refused - a role named counter operator already exists");
  });
  it("refuses a grant the desk may not be given, in the domain's own sentence", async () => {
    const msg = await refused(422, "POST", "/admin/roles", { name: "Till Storekeeper", desk: "counter", perms: { f: { issue_desk: "edit" }, a: [] } });
    expect(msg).toMatch(/can't be given edit access to/);
  });
  it("refuses an action held without its parent feature", async () => {
    const msg = await refused(422, "POST", "/admin/roles", { name: "Voider", desk: "manager", perms: { f: {}, a: ["void_bill"] } });
    expect(msg).toMatch(/needs at least view access to/);
  });
});

describe("PATCH /admin/roles/:id", () => {
  it("renames a role and every account on it reads the new name", async () => {
    const r = await ok("PATCH", "/admin/roles/ROLE-001", { name: "Cashier" });
    expect(r.result.name).toBe("Cashier");
    const [u1] = await app.db.select().from(users).where(eq(users.id, "u1"));
    expect(u1.roleLabel).toBe("Cashier");
    const [row] = await app.db.select().from(roles).where(eq(roles.id, "ROLE-001"));
    expect(row.version).toBe(2);
    await ok("PATCH", "/admin/roles/ROLE-001", { name: "Counter Operator" });
    const [back] = await app.db.select().from(users).where(eq(users.id, "u1"));
    expect(back.roleLabel).toBe("Counter Operator");
  });
  it("changes what a role holds, and says it reaches the holders at once", async () => {
    const perms: Permissions = { ...DESK_DEFAULTS.counter.perms, f: { ...DESK_DEFAULTS.counter.perms.f, z_report: "view" } };
    const r = await ok("PATCH", "/admin/roles/ROLE-001", { perms });
    expect(r.result.perms).toEqual(perms);
    expect(r.message).toBe("Saved Counter Operator. It takes effect for its 2 holders straight away.");
    await ok("PATCH", "/admin/roles/ROLE-001", { perms: DESK_DEFAULTS.counter.perms });
  });
  it("refuses a save that changes nothing, even with the permissions listed in another order", async () => {
    const reordered: Permissions = { f: Object.fromEntries(Object.entries(DESK_DEFAULTS.counter.perms.f).reverse()), a: [] };
    expect(await refused(422, "PATCH", "/admin/roles/ROLE-001", { name: "Counter Operator", perms: reordered }))
      .toBe("Nothing to save - Counter Operator already reads that way");
  });
  it("refuses a new desk once the role has been given to anybody, and allows it before", async () => {
    expect(await refused(422, "PATCH", "/admin/roles/ROLE-003", { desk: "buyer" }))
      .toBe("Refused - Store Keeper has been given to staff, so its desk can no longer change. Create a new role for the other desk instead.");
    const r = await fresh("store", { f: { item_master: "edit" }, a: [] });
    const moved = await ok("PATCH", `/admin/roles/${r.id}`, { desk: "buyer" });
    expect(moved.result.desk).toBe("buyer");
  });
  it("refuses a grant that does not fit the desk it would end up on", async () => {
    const r = await fresh("store", { f: { issue_desk: "edit" }, a: [] });
    // issue_desk is the store's alone: moving the role to the buyer desk with it still held is refused.
    expect(await refused(422, "PATCH", `/admin/roles/${r.id}`, { desk: "buyer" })).toMatch(/can't be given/);
  });
  it("refuses a rename onto another role's name, and answers 404 for a role that does not exist", async () => {
    const r = await fresh();
    expect(await refused(409, "PATCH", `/admin/roles/${r.id}`, { name: "STORE KEEPER" })).toBe("Refused - a role named STORE KEEPER already exists");
    expect(await refused(404, "PATCH", "/admin/roles/ROLE-999", { name: "Nobody" })).toBe("There is no role ROLE-999.");
  });
});

describe("deactivating, reactivating and deleting a role", () => {
  it("refuses to deactivate a role anybody active holds, naming them", async () => {
    expect(await refused(422, "POST", "/admin/roles/ROLE-001/deactivate"))
      .toBe("Refused - Counter Operator is still held by Kavitha Raman (RC-4471) and Deepa Selvam (RC-4482). Move each of them to another role first.");
  });
  it("switches off a role nobody holds, and back on; each refuses a second time", async () => {
    const r = await fresh();
    const off = await ok("POST", `/admin/roles/${r.id}/deactivate`);
    expect(off.result.active).toBe(false);
    expect(await refused(422, "POST", `/admin/roles/${r.id}/deactivate`)).toBe(`${r.name} is already deactivated`);
    const on = await ok("POST", `/admin/roles/${r.id}/reactivate`);
    expect(on.result.active).toBe(true);
    expect(await refused(422, "POST", `/admin/roles/${r.id}/reactivate`)).toBe(`${r.name} is already active`);
    const log = await app.db.select().from(adminActions).where(eq(adminActions.targetName, r.name));
    expect(log.map((l) => l.action).sort()).toEqual(["role_create", "role_deactivate", "role_reactivate"]);
  });
  it("deletes a role nobody was ever given, and refuses one that was", async () => {
    const r = await fresh();
    const gone = await ok("DELETE", `/admin/roles/${r.id}`);
    expect(gone.message).toBe(`Deleted the role ${r.name}.`);
    expect(await app.db.select().from(roles).where(eq(roles.id, r.id))).toHaveLength(0);
    expect(await refused(404, "DELETE", `/admin/roles/${r.id}`)).toBe(`There is no role ${r.id}.`);
    expect(await refused(422, "DELETE", "/admin/roles/ROLE-005"))
      .toBe("Refused - Procurement Officer has been given to staff, so it can only be deactivated, never deleted");
  });
});

describe("roles and accounts", () => {
  it("giving a role to an account marks it assigned for good, and counts the holder", async () => {
    const r = await fresh("store", { f: { store_stock: "view", issue_desk: "edit" }, a: [] });
    const hire = await call("POST", "/admin/users", { name: "Siva K", email: "siva.k@royalcare.in", roleId: r.id, loc: "store" });
    expect(hire.statusCode, hire.body).toBe(200);
    expect(hire.json().result).toMatchObject({ rid: r.id, r: "store", rl: r.name });
    expect(hire.json().changed).toEqual(["accounts", "roles"]);
    expect(await role(r.id)).toMatchObject({ everAssigned: true, holders: 1 });
    expect(await refused(422, "DELETE", `/admin/roles/${r.id}`)).toMatch(/can only be deactivated/);
    // The holder deactivated, the role can go off - and the account cannot come back onto it.
    const id = hire.json().result.id as string;
    expect((await call("POST", `/admin/users/${id}/deactivate`)).statusCode).toBe(200);
    expect((await role(r.id)).holders).toBe(0);
    await ok("POST", `/admin/roles/${r.id}/deactivate`);
    expect(await refused(422, "POST", `/admin/users/${id}/reactivate`))
      .toBe(`Refused - Siva K's role, ${r.name}, is deactivated. Give them an active role first`);
    // Nor can anybody new be given it.
    expect(await refused(422, "POST", "/admin/users", { name: "Latha M", email: "latha.m@royalcare.in", roleId: r.id, loc: "store" }))
      .toBe(`Refused - ${r.name} is deactivated, so it can't be given to anybody`);
  });
  it("refuses a role id that does not exist, and a role at a location its desk never works", async () => {
    expect(await refused(400, "POST", "/admin/users", { name: "Nobody", email: "n@royalcare.in", roleId: "ROLE-999", loc: "store" })).toMatch(/unknown role "ROLE-999"/);
    expect(await refused(400, "POST", "/admin/users", { name: "Nobody", email: "n@royalcare.in", roleId: "ROLE-004", loc: "coffee" }))
      .toBe("Kitchen In-charge works at the Central Kitchen, not at Coffee Shop");
  });
});
