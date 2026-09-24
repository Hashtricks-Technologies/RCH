import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import type { AdminRole, Permissions } from "@rch/contract";
import { ACTIONS, DESK_DEFAULTS, permissionRefusal } from "@rch/domain";
import type { App } from "../../app.js";
import { buildTestApp } from "../../test/app.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { seedTestDb } from "../../test/seed.js";
import { users } from "../../db/schema/index.js";

// What a role holds is what opens a door - not the desk it sits on. Each case gives a role
// something its desk's seeded role never had (or takes something away) and walks through the door.

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "roles_access" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

const send = async (user: string, method: InjectOptions["method"], url: string, payload?: Record<string, unknown>) => {
  const headers = { ...(await authHeaders(app, user)), ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) };
  return app.inject({ method, url: `/api/v1${url}`, headers, ...(payload === undefined ? {} : { payload }) });
};
/** u7 (RC-0001) is the seed's super admin. */
const asAdmin = async (method: InjectOptions["method"], url: string, payload: Record<string, unknown>) => {
  const r = await send("u7", method, url, payload);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().result as { id: string };
};
let n = 0;
const newRole = async (desk: AdminRole["desk"], perms: Permissions) =>
  (await asAdmin("POST", "/admin/roles", { name: `Access probe ${++n}`, desk, perms })).id;
/** A fresh account on a role, past its first-sign-in password change. */
const hire = async (roleId: string, loc: string) => {
  const tag = randomUUID().slice(0, 6);
  const { id } = await asAdmin("POST", "/admin/users", { name: `Probe ${tag}`, email: `probe.${tag}@royalcare.in`, roleId, loc });
  await app.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, id));
  return id;
};
const counter = DESK_DEFAULTS.counter.perms;

describe("a hospital-wide grant on the counter desk acts hospital-wide", () => {
  it("a counter role given Approvals approves, and withdraws, another outlet's request", async () => {
    const lead = await hire(await newRole("counter", { f: { ...counter.f, approvals: "edit" }, a: [] }), "coffee");
    const id = await given.request(app.db, { from: "kiosk", by: "u6", lines: [{ it: "butter", qty: 1 }] });
    const approve = await send(lead, "POST", `/requests/${id}/approve`, { appr: [1], note: "" });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json().result.request.lines[0]).toMatchObject({ it: "butter", appr: 1 });
    // Its withdrawal is hospital-wide too: the kiosk's request is not the coffee shop's, and no
    // requireLocOf stops it.
    const cancel = await send(lead, "POST", `/requests/${id}/cancel`);
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json().result.st).toBe("Cancelled");
  });

  it("the seeded counter still withdraws only its own outlet's request", async () => {
    const id = await given.request(app.db, { from: "kiosk", by: "u6", lines: [{ it: "butter", qty: 1 }] });
    const r = await send("u1", "POST", `/requests/${id}/cancel`);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error.message).toBe("You can only do this for your own counter.");
  });
});

describe("view where edit is needed is a 403 with the sentence, not a 404", () => {
  it("a counter role that sees Receivables & settlements may not record one", async () => {
    const viewer = await hire(await newRole("counter", { f: { ...counter.f, settlements: "view" }, a: [] }), "coffee");
    const r = await send(viewer, "POST", "/settlements", { kind: "staff", id: "u1", amount: 10, mode: "Cash" });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error.message).toBe(permissionRefusal("settlements"));
    expect(r.json().error.message).toBe("You can see Receivables & settlements but not change them - ask the administrator for edit access.");
  });

  it("a role that takes bills but does not hold the void is told what to ask for", async () => {
    const till = await hire(await newRole("counter", { f: { billing: "edit" }, a: [] }), "coffee");
    const no = await given.bill(app.db, { loc: "coffee", total: 40, tender: "Cash" });
    const r = await send(till, "POST", `/bills/${encodeURIComponent(no)}/void`, { reason: "Wrong item" });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error.message).toBe(ACTIONS.void_bill.refusal);
  });
});

describe("a change to a role lands on the next request", () => {
  it("revoking Approvals makes the same token's reject a 404", async () => {
    const role = await newRole("counter", { f: { ...counter.f, approvals: "edit" }, a: [] });
    const lead = await hire(role, "coffee");
    const token = await authHeaders(app, lead);
    const reject = async () => {
      const id = await given.request(app.db, { from: "kiosk", by: "u6", lines: [{ it: "butter", qty: 1 }] });
      return app.inject({ method: "POST", url: `/api/v1/requests/${id}/reject`, headers: { ...token, "idempotency-key": randomUUID() }, payload: { note: "Not today" } });
    };
    expect((await reject()).statusCode).toBe(200);

    await asAdmin("PATCH", `/admin/roles/${role}`, { perms: counter });
    const after = await reject();
    expect(after.statusCode, after.body).toBe(404);
    // Nothing else about the account changed: the till is still open to it.
    expect((await app.inject({ method: "GET", url: "/api/v1/register/x", headers: token })).statusCode).toBe(200);
  });
});
