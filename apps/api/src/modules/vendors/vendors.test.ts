import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { InjectOptions } from "fastify";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { warmPool } from "../../test/db.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "vendors" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload?: Record<string, unknown>) => {
  const opts: InjectOptions = { method: "POST", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) };
  return app.inject(opts);
};
const patch = async (user: string, url: string, payload?: Record<string, unknown>) => {
  const opts: InjectOptions = { method: "PATCH", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) };
  return app.inject(opts);
};
// GET /vendors is Task 4's and does not exist in this worktree — read the snapshot's own slice.
const vendorsList = async () => (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u5") })).json().vendors;

describe("POST /vendors", () => {
  it("adds a vendor with the next id, active by default", async () => {
    const r = await post("u5", "/vendors", { n: "Kumaran Traders", gstin: "33AAACA1234F1Z5", contact: "Kumar S", ph: "98430 11220", terms: "30 days", lead: 2, groups: ["Grocery"] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ n: "Kumaran Traders", active: true, lead: 2, groups: ["Grocery"] });
    expect(b.result.id).toMatch(/^VN-\d{3}$/);
    expect(b.changed).toEqual(["vendors"]);
    expect(b.message).toBe(`Kumaran Traders added as ${b.result.id}`);
  });

  it("refuses a vendor with no name, a malformed GSTIN, and a name already on the list", async () => {
    expect((await post("u5", "/vendors", { n: "   " })).json().error.message).toBe("Give the vendor a name before saving");
    expect((await post("u5", "/vendors", { n: "Bad GST Co", gstin: "33AAACA1234" })).json().error.message)
      .toBe("That is not a GSTIN — 15 characters, like 33AAACA1234F1Z5");
    expect((await post("u5", "/vendors", { n: "aavin dairy depot" })).json().error.message)
      .toBe("aavin dairy depot is already on the vendor list");
    // and an empty GSTIN is fine — the store has always allowed one
    expect((await post("u5", "/vendors", { n: "No GST Traders" })).statusCode).toBe(200);
  });

  it("adds one vendor, not two, when the same name is submitted twice at once", async () => {
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u5", "/vendors", { n: "Twice Traders" }), post("u5", "/vendors", { n: "twice traders" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });
});

describe("PATCH /vendors/:id", () => {
  it("edits in place, and deactivates rather than deletes", async () => {
    const id = await given.vendor(app.testDb!.db, { n: "Editable Traders" });
    expect((await patch("u5", `/vendors/${id}`, { terms: "45 days", lead: 7 })).json())
      .toMatchObject({ result: { terms: "45 days", lead: 7 }, message: "Editable Traders updated" });

    const off = (await patch("u5", `/vendors/${id}`, { active: false })).json();
    expect(off.result.active).toBe(false);
    expect(off.message).toBe("Editable Traders deactivated — existing orders keep it, new drafts cannot pick it");
    const on = (await patch("u5", `/vendors/${id}`, { active: true })).json();
    expect(on.message).toBe("Editable Traders is active again and can be picked on new orders");
    // The record survives: history has to stay readable on the orders it already carries.
    expect((await vendorsList()).some((v: { id: string }) => v.id === id)).toBe(true);
  });

  it("refuses an empty patch, and 404s a vendor that is not there", async () => {
    const id = await given.vendor(app.testDb!.db, {});
    expect((await patch("u5", `/vendors/${id}`, {})).json().error.message).toBe(`Nothing to change on ${id}`);
    expect((await patch("u5", "/vendors/VN-777", { lead: 1 })).json().error.message).toBe("There is no vendor VN-777.");
  });

  it("changes only the field it names — a patch of one does not reset the rest", async () => {
    // The trap `PatchVendorBodySchema` is declared field-by-field to avoid: a partial of a
    // defaulted schema parses {} into { lead: 0, groups: [] }, and every edit would have
    // quietly wiped a vendor's lead time and the groups the procurement list suggests from.
    const id = await given.vendor(app.testDb!.db, { n: "Untouched Traders", lead: 7, groups: ["Dairy", "Bakery"] });
    const b = (await patch("u5", `/vendors/${id}`, { terms: "45 days" })).json();
    expect(b.result).toMatchObject({ terms: "45 days", lead: 7, groups: ["Dairy", "Bakery"] });
  });

  it("is absent for every role but the buyer", async () => {
    const id = await given.vendor(app.testDb!.db, {});
    for (const u of ["u1", "u2", "u3", "u4"]) {
      expect((await patch(u, `/vendors/${id}`, { lead: 1 })).statusCode).toBe(404);
      expect((await post(u, "/vendors", { n: "Nope" })).statusCode).toBe(404);
    }
  });

  it("refuses a rename onto another vendor's name, leaving the row unchanged, but allows a case-only rename of its own name", async () => {
    const a = await given.vendor(app.testDb!.db, { n: "Rename Source" });
    const b = await given.vendor(app.testDb!.db, { n: "Rename Target" });

    const r = await patch("u5", `/vendors/${a}`, { n: "rename target" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("rename target is already on the vendor list");
    // The update is the arbiter: the row it failed to write is unchanged.
    expect((await vendorsList()).find((v: { id: string }) => v.id === a).n).toBe("Rename Source");

    // Renaming a vendor to a differently-cased spelling of its own current name is not a
    // collision — the unique index never sees two rows sharing the value, only this one.
    const same = await patch("u5", `/vendors/${b}`, { n: "RENAME TARGET" });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().result.n).toBe("RENAME TARGET");
  });
});
