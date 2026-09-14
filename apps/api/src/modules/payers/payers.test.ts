import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { InjectOptions } from "fastify";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { warmPool } from "../../test/db.js";
import { EVENTS_CHANNEL_PREFIX } from "../../lib/events.js";
import type { App } from "../../app.js";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";

let app: App;
let listener: Client;
let heard: string[] = [];

beforeAll(async () => {
  app = await buildTestApp({ schema: "payers" });
  await seedTestDb(app.testDb!.db);
  await app.ready();
  listener = new Client({ connectionString: BASE, options: `-c search_path=${app.testDb!.schemaName},public` });
  await listener.connect();
  listener.on("notification", (m) => { if (m.payload) heard.push(m.payload); });
  await listener.query(`listen "${EVENTS_CHANNEL_PREFIX}${app.testDb!.schemaName}"`);
});
afterAll(async () => { await listener.end(); await app.close(); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload?: Record<string, unknown>) => {
  const opts: InjectOptions = { method: "POST", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) };
  return app.inject(opts);
};
const patch = async (user: string, url: string, payload?: Record<string, unknown>) => {
  const opts: InjectOptions = { method: "PATCH", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) };
  return app.inject(opts);
};
/** The till's read: live payers only, split into the three lists a payer picker offers. `u2` is
 *  the outlet manager, the one role that keeps the register - and one of the two `scopeRoster`
 *  lets read it at all. */
const roster = async (user = "u2") =>
  (await app.inject({ method: "GET", url: "/api/v1/roster", headers: await authHeaders(app, user) })).json();
/** The manager's read: the register whole, closed accounts included. */
const register = async (user = "u2") =>
  app.inject({ method: "GET", url: "/api/v1/payers", headers: await authHeaders(app, user) });
/** NOTIFY is delivered asynchronously; give the listener socket a turn. */
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("POST /payers", () => {
  it("adds a patient, a staff member and a department, active by default", async () => {
    const p = await post("u2", "/payers", { kind: "patient", id: "IP-7001", name: "Latha Devi · Ward 4A" });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().result).toEqual({ kind: "patient", id: "IP-7001", name: "Latha Devi · Ward 4A", active: true });
    expect(p.json().changed).toEqual(["roster", "payers"]);
    expect(p.json().message).toBe("Latha Devi · Ward 4A added to the patient roster as IP-7001");

    const s = await post("u2", "/payers", { kind: "staff", id: "E2291", name: "Kavitha Raman" });
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().message).toBe("Kavitha Raman added to the staff member roster as E2291");

    const d = await post("u2", "/payers", { kind: "dept", id: "CC-PHY", name: "Physiotherapy" });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().result.active).toBe(true);

    // Each lands on its own list, not in one flat register.
    const r = await roster();
    expect(r.patients.map((x: { id: string }) => x.id)).toContain("IP-7001");
    expect(r.staff.map((x: { id: string }) => x.id)).toContain("E2291");
    expect(r.depts.map((x: { id: string }) => x.id)).toContain("CC-PHY");
  });

  it("refuses a payer with no name", async () => {
    const r = await post("u2", "/payers", { kind: "patient", id: "IP-7002", name: "   " });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Give the patient a name before saving");
    // And a blank id, which is the same kind of nothing - the hospital's number, not ours.
    expect((await post("u2", "/payers", { kind: "dept", id: " ", name: "Nowhere" })).json().error.message)
      .toBe("Give the department an id before saving");
  });

  it("refuses an id already on that roster, and allows the same id on another roster", async () => {
    expect((await post("u2", "/payers", { kind: "staff", id: "E7100", name: "Once" })).statusCode).toBe(200);
    const again = await post("u2", "/payers", { kind: "staff", id: "E7100", name: "Twice" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe("E7100 is already on the staff member roster");
    // The three rosters are numbered independently - a payroll number may read like a cost
    // centre, and only the (kind, id) pair is the key.
    expect((await post("u2", "/payers", { kind: "dept", id: "E7100", name: "A department that shares the number" })).statusCode).toBe(200);
  });

  it("adds one payer, not two, when the same id is submitted twice at once", async () => {
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u2", "/payers", { kind: "patient", id: "IP-7777", name: "First writer" }),
      post("u2", "/payers", { kind: "patient", id: "IP-7777", name: "Second writer" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    const r = await roster();
    expect(r.patients.filter((x: { id: string }) => x.id === "IP-7777")).toHaveLength(1);
  });
});

describe("PATCH /payers/:kind/:id", () => {
  it("renames in place and deactivates rather than deletes", async () => {
    await post("u2", "/payers", { kind: "patient", id: "IP-7010", name: "Moved Ward 1" });

    const renamed = await patch("u2", "/payers/patient/IP-7010", { name: "Moved Ward 2" });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json()).toMatchObject({ result: { name: "Moved Ward 2" }, message: "Moved Ward 2 updated" });

    const off = await patch("u2", "/payers/patient/IP-7010", { active: false });
    expect(off.json().result.active).toBe(false);
    expect(off.json().message).toBe("Moved Ward 2 deactivated - bills already posted to them stay, new ones cannot");

    const on = await patch("u2", "/payers/patient/IP-7010", { active: true });
    expect(on.json().message).toBe("Moved Ward 2 is active again and can be billed to");
    // The row survives a deactivation: the bills already posted to it have to stay readable.
    expect((await roster()).patients.map((x: { id: string }) => x.id)).toContain("IP-7010");

    // And it is still on the manager's own read while it is switched off, which is the whole
    // reason that read exists - a payer nobody can see is a payer nobody can reopen.
    await patch("u2", "/payers/patient/IP-7010", { active: false });
    expect((await roster()).patients.map((x: { id: string }) => x.id)).not.toContain("IP-7010");
    expect((await register()).json()).toContainEqual({ kind: "patient", id: "IP-7010", name: "Moved Ward 2", active: false });
  });

  it("refuses an empty patch, and 404s a payer that is not there, in the till's own words", async () => {
    await post("u2", "/payers", { kind: "staff", id: "E7020", name: "Nothing To Change" });
    expect((await patch("u2", "/payers/staff/E7020", {})).json().error.message).toBe("Nothing to change on E7020");

    // `PAYER_LABEL` is one list (lib/wire.ts) - the register says "staff member" because the
    // till says "staff member" when a bill names a payer the roster has never heard of.
    const gone = await patch("u2", "/payers/staff/E9999", { name: "Nobody" });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.message).toBe("There is no staff member E9999 on the roster.");
    expect((await patch("u2", "/payers/patient/IP-0000", { active: false })).json().error.message)
      .toBe("There is no patient IP-0000 on the roster.");
    expect((await patch("u2", "/payers/dept/CC-NONE", { active: false })).json().error.message)
      .toBe("There is no department CC-NONE on the roster.");
  });

  it("changes only the field it names", async () => {
    // The trap `PatchPayerBodySchema` is declared field by field to avoid: a partial of a
    // defaulted schema parses {} into { active: true }, and closing an account with a rename
    // would quietly reopen it (or a rename would reset the switch).
    await post("u2", "/payers", { kind: "dept", id: "CC-KEEP", name: "Untouched" });
    await patch("u2", "/payers/dept/CC-KEEP", { active: false });
    const r = await patch("u2", "/payers/dept/CC-KEEP", { name: "Untouched, renamed" });
    expect(r.json().result).toEqual({ kind: "dept", id: "CC-KEEP", name: "Untouched, renamed", active: false });
  });

});

describe("GET /payers and GET /roster", () => {
  it("lists every payer for the manager, inactive included, and is absent for every other role", async () => {
    await post("u2", "/payers", { kind: "staff", id: "E7040", name: "Still Here" });
    await post("u2", "/payers", { kind: "staff", id: "E7041", name: "Gone Last Week" });
    await patch("u2", "/payers/staff/E7041", { active: false });

    const r = await register();
    expect(r.statusCode, r.body).toBe(200);
    const all = r.json() as { kind: string; id: string; name: string; active: boolean }[];
    expect(all).toContainEqual({ kind: "staff", id: "E7040", name: "Still Here", active: true });
    expect(all).toContainEqual({ kind: "staff", id: "E7041", name: "Gone Last Week", active: false });
    // The till's read stops at the live rows; this one does not, which is the difference.
    expect((await roster()).staff.map((x: { id: string }) => x.id)).not.toContain("E7041");
    // Ordered kind then name, which is the order the manager's three tabs read it in.
    const staff = all.filter((x) => x.kind === "staff").map((x) => x.name);
    expect(staff).toEqual([...staff].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

    // The whole register is the manager's alone - a closed account is not a counter's business,
    // and the three roles that never open a payer picker have no use for either read.
    for (const u of ["u1", "u3", "u4", "u5"]) expect((await register(u)).statusCode).toBe(404);
  });

  it("is absent for every role but the manager", async () => {
    // Made here rather than leaned on from the case before, so this one says what it needs and
    // cannot start passing (or failing) because a neighbour was reordered.
    await post("u2", "/payers", { kind: "staff", id: "E7050", name: "Role Gate" });
    for (const u of ["u1", "u3", "u4", "u5"]) {
      expect((await post(u, "/payers", { kind: "staff", id: "E8000", name: "Nope" })).statusCode).toBe(404);
      expect((await patch(u, "/payers/staff/E7050", { name: "Nope" })).statusCode).toBe(404);
    }
    // The row is untouched by four refused patches - a 404 is the door not existing, not a
    // write that half happened.
    expect((await register()).json()).toContainEqual({ kind: "staff", id: "E7050", name: "Role Gate", active: true });

    // `GET /roster` itself is "any", but cut: the kitchen, the store and the buyer never open a
    // payer picker, so it hands them an empty one (`scopeRoster`, Wave 1).
    expect(await roster("u3")).toEqual({ patients: [], staff: [], depts: [] });
    expect(await roster("u4")).toEqual({ patients: [], staff: [], depts: [] });
    expect(await roster("u5")).toEqual({ patients: [], staff: [], depts: [] });
    expect((await roster("u1")).staff.length).toBeGreaterThan(0);
  });

  it("a deactivated payer disappears from GET /roster and can no longer be billed", async () => {
    await post("u2", "/payers", { kind: "staff", id: "E7030", name: "Leaving Today" });
    expect((await roster()).staff.map((x: { id: string }) => x.id)).toContain("E7030");

    const bill = { loc: "coffee", tender: "Staff credit", payer: { kind: "staff", id: "E7030", name: "Leaving Today" }, lines: [{ it: "juice", qty: 1 }] };
    expect((await post("u1", "/bills", bill)).statusCode, "a live payer bills").toBe(200);

    await patch("u2", "/payers/staff/E7030", { active: false });
    expect((await roster()).staff.map((x: { id: string }) => x.id)).not.toContain("E7030");

    const refused = await post("u1", "/bills", bill);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.message).toBe("There is no staff member E7030 on the roster");
  });
});

describe("what a payer write announces", () => {
  it("announces roster, and the same array is on the response", async () => {
    // Drain first: NOTIFY is delivered asynchronously, so a notice from the case before this
    // one can still be on the socket when the list is cleared.
    await settle();
    heard = [];
    // Both collections, every time: `roster` is the till's live list and `payers` the manager's
    // whole register, and a rename or a switch moves what each of them answers.
    const added = await post("u2", "/payers", { kind: "dept", id: "CC-ANN", name: "Announcements" });
    expect(added.json().changed).toEqual(["roster", "payers"]);
    const changed = await patch("u2", "/payers/dept/CC-ANN", { active: false });
    expect(changed.json().changed).toEqual(["roster", "payers"]);

    await settle();
    const said = heard.map((h) => (JSON.parse(h) as { collections: string[] }).collections);
    expect(said).toEqual([["roster", "payers"], ["roster", "payers"]]);

    // A refusal announces nothing: `emitChanged` runs inside the write's own transaction.
    heard = [];
    expect((await patch("u2", "/payers/dept/CC-ANN", {})).statusCode).toBe(422);
    await settle();
    expect(heard).toEqual([]);
  });
});
