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
/** The register as the caller reads it back. `u2` is the outlet manager, the one role that
 *  keeps it — and one of the two `scopeRoster` lets read it at all. */
const roster = async (user = "u2") =>
  (await app.inject({ method: "GET", url: "/api/v1/roster", headers: await authHeaders(app, user) })).json();
/** NOTIFY is delivered asynchronously; give the listener socket a turn. */
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("POST /payers", () => {
  it("adds a patient, a staff member and a department, active by default", async () => {
    const p = await post("u2", "/payers", { kind: "patient", id: "IP-7001", name: "Latha Devi · Ward 4A" });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().result).toEqual({ kind: "patient", id: "IP-7001", name: "Latha Devi · Ward 4A", active: true });
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
    // And a blank id, which is the same kind of nothing — the hospital's number, not ours.
    expect((await post("u2", "/payers", { kind: "dept", id: " ", name: "Nowhere" })).json().error.message)
      .toBe("Give the department an id before saving");
  });

  it("refuses an id already on that roster, and allows the same id on another roster", async () => {
    expect((await post("u2", "/payers", { kind: "staff", id: "E7100", name: "Once" })).statusCode).toBe(200);
    const again = await post("u2", "/payers", { kind: "staff", id: "E7100", name: "Twice" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe("E7100 is already on the staff member roster");
    // The three rosters are numbered independently — a payroll number may read like a cost
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
    expect(off.json().message).toBe("Moved Ward 2 deactivated — bills already posted to them stay, new ones cannot");

    const on = await patch("u2", "/payers/patient/IP-7010", { active: true });
    expect(on.json().message).toBe("Moved Ward 2 is active again and can be billed to");
    // The row survives a deactivation: the bills already posted to it have to stay readable.
    expect((await roster()).patients.map((x: { id: string }) => x.id)).toContain("IP-7010");
  });

  it("refuses an empty patch, and 404s a payer that is not there, in the till's own words", async () => {
    await post("u2", "/payers", { kind: "staff", id: "E7020", name: "Nothing To Change" });
    expect((await patch("u2", "/payers/staff/E7020", {})).json().error.message).toBe("Nothing to change on E7020");

    // `PAYER_LABEL` is one list (lib/wire.ts) — the register says "staff member" because the
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

  it("is absent for every role but the manager", async () => {
    for (const u of ["u1", "u3", "u4", "u5"]) {
      expect((await post(u, "/payers", { kind: "staff", id: "E8000", name: "Nope" })).statusCode).toBe(404);
      expect((await patch(u, "/payers/staff/E7020", { name: "Nope" })).statusCode).toBe(404);
    }
    // And the register itself is "any", but cut: the kitchen, the store and the buyer never open
    // a payer picker, so `GET /roster` hands them an empty one (`scopeRoster`, Wave 1).
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

  it("announces roster, and the same array is on the response", async () => {
    // Drain first: NOTIFY is delivered asynchronously, so a notice from the case before this
    // one can still be on the socket when the list is cleared.
    await settle();
    heard = [];
    const added = await post("u2", "/payers", { kind: "dept", id: "CC-ANN", name: "Announcements" });
    expect(added.json().changed).toEqual(["roster"]);
    const changed = await patch("u2", "/payers/dept/CC-ANN", { active: false });
    expect(changed.json().changed).toEqual(["roster"]);

    await settle();
    const said = heard.map((h) => (JSON.parse(h) as { collections: string[] }).collections);
    expect(said).toEqual([["roster"], ["roster"]]);

    // A refusal announces nothing: `emitChanged` runs inside the write's own transaction.
    heard = [];
    expect((await patch("u2", "/payers/dept/CC-ANN", {})).statusCode).toBe(422);
    await settle();
    expect(heard).toEqual([]);
  });
});
