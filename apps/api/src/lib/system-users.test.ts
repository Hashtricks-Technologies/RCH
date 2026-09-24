import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { nextEmpNo } from "@rch/domain";
import type { App } from "../app.js";
import { buildTestApp } from "../test/app.js";
import { authHeaders } from "../test/auth.js";
import { truncateAll } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { users } from "../db/schema/index.js";
import { readUsers } from "../modules/snapshot/readers/master.js";
import { actorOf } from "./audit.js";
import { withTransaction } from "./db.js";
import { SYSTEM_QR, systemOperator } from "./system-users.js";
import { deactivateUser, resetPassword, setAdmin } from "./users-admin.js";
import { roleLabelOf } from "./wire.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "system_users" }); await app.ready(); });
beforeEach(async () => {
  await truncateAll(app.testDb!.db);
  await seedTestDb(app.testDb!.db);
  await withTransaction(app.db, (tx) => systemOperator(tx));
});
afterAll(async () => { await app.close(); });

const admin = () => authHeaders(app, "u7");
const login = (emp: string, password: string) =>
  app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { emp, password } });

describe("systemOperator", () => {
  it("creates the QR Orders account once, with no role, no password and no shift, and answers its id every time", async () => {
    expect(await withTransaction(app.db, (tx) => systemOperator(tx))).toBe(SYSTEM_QR.id);
    const rows = await app.db.select().from(users).where(eq(users.system, true));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "sys-qr", empNo: "SYS-QR", name: "QR Orders", role: "counter", roleId: null, loc: "store",
      passwordHash: "!", admin: false, system: true, active: true,
    });
  });
  it("can never also be the super admin", async () => {
    await withTransaction(app.db, (tx) => systemOperator(tx));
    await expect(app.db.update(users).set({ admin: true }).where(eq(users.id, SYSTEM_QR.id))).rejects.toMatchObject({ cause: expect.objectContaining({ constraint: "users_role_id_ck" }) });
  });
  it("is settled by the key when two transactions race to create it", async () => {
    await app.db.delete(users).where(eq(users.id, SYSTEM_QR.id));
    const ids = await Promise.all([1, 2].map(() => withTransaction(app.db, (tx) => systemOperator(tx))));
    expect(ids).toEqual([SYSTEM_QR.id, SYSTEM_QR.id]);
    const n = (await app.db.execute(sql`select count(*)::int as n from users where system`)).rows[0] as { n: number };
    expect(n.n).toBe(1);
  });
  it("is labelled System wherever a role label stands, and stands at no location in the audit log", async () => {
    expect(roleLabelOf({ admin: false, system: true, roleLabel: "Counter Operator" })).toBe("System");
    expect(roleLabelOf({ admin: true, system: false, roleLabel: "Outlet Manager" })).toBe("Super Admin");
    expect(await actorOf(app.db, SYSTEM_QR.id)).toEqual({ id: "sys-qr", emp: "SYS-QR", name: "QR Orders", role: "System", loc: "" });
  });
});

describe("the system account is nobody's to sign in as or manage", () => {
  it("refuses a sign-in with the unknown account's sentence, before any password is checked", async () => {
    const unknown = await login("RC-0000", "changeme");
    const sys = await login("SYS-QR", "!");
    expect(sys.statusCode).toBe(401);
    expect(sys.json().error.message).toBe(unknown.json().error.message);
  });
  it("is not in the sign-in directory", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/directory" });
    expect(res.statusCode).toBe(200);
    const emps = (res.json() as Array<{ emp: string }>).map((e) => e.emp);
    expect(emps).toContain("RC-4471");
    expect(emps).not.toContain("SYS-QR");
  });
  it("is not on the admin's account list, and any edit or delete of it is a 404", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/admin/users", headers: await admin() });
    expect((list.json() as Array<{ id: string }>).map((u) => u.id)).not.toContain("sys-qr");
    const write = async (method: "PATCH" | "DELETE" | "POST", url: string, payload?: Record<string, unknown>) =>
      app.inject({ method, url, headers: { ...(await admin()), "idempotency-key": randomUUID() }, payload });
    expect((await write("PATCH", "/api/v1/admin/users/sys-qr", { roleId: "ROLE-001", loc: "rest" })).statusCode).toBe(404);
    expect((await write("DELETE", "/api/v1/admin/users/sys-qr")).statusCode).toBe(404);
    expect((await write("POST", "/api/v1/admin/users/sys-qr/reset-password")).statusCode).toBe(404);
    expect((await write("POST", "/api/v1/admin/users/sys-qr/deactivate")).statusCode).toBe(404);
  });
  it("is not counted among the staff of the location it is placed at", async () => {
    const outlets = await app.inject({ method: "GET", url: "/api/v1/admin/locations", headers: await admin() });
    expect(outlets.statusCode, outlets.body).toBe(200);
    const store = (outlets.json() as Array<{ key: string; staff: number }>).find((l) => l.key === "store");
    const people = (await app.db.execute(sql`select count(*)::int as n from users where loc = 'store' and active and not admin and not system`)).rows[0] as { n: number };
    expect(store?.staff).toBe(people.n);
  });
  it("is unknown to the users CLI", async () => {
    await expect(resetPassword(app.db, "SYS-QR", "a-long-temporary-password")).rejects.toThrow("no user with employee number SYS-QR");
    await expect(deactivateUser(app.db, "SYS-QR")).rejects.toThrow("no user with employee number SYS-QR");
    await expect(setAdmin(app.db, "SYS-QR", true)).rejects.toThrow("no user with employee number SYS-QR");
  });
  it("is nobody's colleague on the snapshot", async () => {
    const ids = (await readUsers(app.db)).map((u) => u.id);
    expect(ids).toContain("u1");
    expect(ids).not.toContain("sys-qr");
  });
  it("leaves the employee numbers and user ids the server hands out where they were", async () => {
    const emps = (await app.db.select({ emp: users.empNo }).from(users).where(eq(users.system, false))).map((u) => u.emp);
    const res = await app.inject({
      method: "POST", url: "/api/v1/admin/users", headers: { ...(await admin()), "idempotency-key": randomUUID() },
      payload: { name: "Anitha R", email: "anitha.r@royalcare.in", roleId: "ROLE-001", loc: "rest" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result.emp).toBe(nextEmpNo(emps));
    expect(res.json().result.id).toMatch(/^u\d+$/);
  });
});
