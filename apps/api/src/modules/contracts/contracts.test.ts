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
beforeAll(async () => { app = await buildTestApp({ schema: "contracts" }); await seedTestDb(app.testDb!.db); await app.ready(); });
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
const del = async (user: string, url: string) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers: await hdr(user) });
// GET /contracts exists now (mounted alongside the rest of buying's reads in
// modules/snapshot/routes.ts), but the snapshot's own slice is the same rows and this file
// predates that route — read it off `GET /snapshot` rather than adding a second reader.
const contractsList = async () => (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u3") })).json().contracts;
// GET /items is a Phase 1 route, so it is safe here — the item names in this file's assertions
// come from the master, not from a number typed into the test.
const getItems = async () => (await app.inject({ method: "GET", url: "/api/v1/items", headers: await authHeaders(app, "u3") })).json();

describe("POST /contracts", () => {
  it("records a rate against a vendor and an item", async () => {
    const b = (await post("u3", "/contracts", { vendorId: "VN-003", it: "bread", rate: 38, from: "2026-04-01", to: "2027-03-31", moq: 20 })).json();
    expect(b.result).toMatchObject({ vendor: "Anandha Provisions", it: "bread", rate: 38, from: "2026-04-01", to: "2027-03-31", moq: 20, active: true });
    expect(b.result.id).toMatch(/^RC-\d+$/);
    expect(b.changed).toEqual(["contracts"]);
    // The item's name comes from the master, so read it rather than typing it — the seed moves.
    const items = await getItems();
    expect(b.message).toBe(`${b.result.id} — ${items.bread.n} at ₹38 with Anandha Provisions`);
  });

  it("refuses a second live contract for the same vendor and item", async () => {
    // RC-101 is Aavin's live milk contract, from the seed.
    const r = await post("u3", "/contracts", { vendorId: "VN-001", it: "milk", rate: 55, from: "2026-04-01", to: "2027-03-31" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${(await getItems()).milk.n} already has a live contract with Aavin Dairy Depot`);
  });

  it("refuses a window that ends before it starts, and a rate of nothing", async () => {
    expect((await post("u3", "/contracts", { vendorId: "VN-003", it: "oil", rate: 120, from: "2027-03-31", to: "2026-04-01" })).json().error.message)
      .toBe("A contract cannot end before it starts");
    expect((await post("u3", "/contracts", { vendorId: "VN-003", it: "oil", rate: 0, from: "2026-04-01", to: "2027-03-31" })).json().error.message)
      .toBe("A contract rate must be more than zero");
  });

  it("404s an unknown vendor or item, and is absent for every role but the store keeper", async () => {
    expect((await post("u3", "/contracts", { vendorId: "VN-777", it: "oil", rate: 1, from: "2026-04-01", to: "2027-03-31" })).json().error.message)
      .toBe("There is no vendor VN-777.");
    expect((await post("u3", "/contracts", { vendorId: "VN-003", it: "nope", rate: 1, from: "2026-04-01", to: "2027-03-31" })).json().error.message)
      .toBe("There is no item nope.");
    for (const u of ["u1", "u2", "u4", "u5"]) {
      expect((await post(u, "/contracts", { vendorId: "VN-003", it: "oil", rate: 1, from: "2026-04-01", to: "2027-03-31" })).statusCode).toBe(404);
    }
  });

  it("records one contract, not two, when the same pair is added twice at once", async () => {
    await warmPool(app.testDb!, 2);
    const body = { vendorId: "VN-004", it: "box", rate: 3, from: "2026-04-01", to: "2027-03-31" };
    const both = await Promise.all([post("u3", "/contracts", body), post("u3", "/contracts", body)]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });
});

describe("PATCH and DELETE /contracts/:id", () => {
  it("edits a rate and its window", async () => {
    const id = await given.contract(app.testDb!.db, { vendorId: "VN-005", it: "leaf", rate: 400 });
    const b = (await patch("u3", `/contracts/${id}`, { rate: 420, to: "2026-12-31" })).json();
    expect(b.result).toMatchObject({ rate: 420, to: "2026-12-31" });
    expect(b.message).toBe(`${id} updated`);
  });

  it("closes a contract without deleting it, and lets it be reopened", async () => {
    const id = await given.contract(app.testDb!.db, { vendorId: "VN-005", it: "beans", rate: 900 });
    const b = (await del("u3", `/contracts/${id}`)).json();
    expect(b.result.active).toBe(false);
    expect(b.message).toBe(`${id} closed — it stays on record but no longer prices an order`);
    expect((await contractsList()).some((c: { id: string }) => c.id === id)).toBe(true);
    expect((await patch("u3", `/contracts/${id}`, { active: true })).json().result.active).toBe(true);
  });

  it("will not reopen one into a pair that already has a live contract", async () => {
    const id = await given.contract(app.testDb!.db, { vendorId: "VN-001", it: "milk", rate: 60, active: false });
    const r = await patch("u3", `/contracts/${id}`, { active: true });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${(await getItems()).milk.n} already has a live contract with Aavin Dairy Depot`);
  });

  it("gives the live slot to exactly one screen when two closed contracts race to reopen it", async () => {
    // Both start closed, so `liveFor`'s pre-check — which locks only rows already `active =
    // true` — finds nothing to lock for either request and both pass it; `rate_contracts_live_uq`
    // is the only thing left standing between them, and `contractsRepo.update`'s catch is what
    // turns the loser's 23505 into this sentence instead of a raw 500.
    const a = await given.contract(app.testDb!.db, { vendorId: "VN-001", it: "bread", rate: 36, active: false });
    const b = await given.contract(app.testDb!.db, { vendorId: "VN-001", it: "bread", rate: 40, active: false });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      patch("u3", `/contracts/${a}`, { active: true }),
      patch("u3", `/contracts/${b}`, { active: true }),
    ]);
    const ok = both.filter((r) => r.statusCode === 200);
    const refused = both.filter((r) => r.statusCode === 422);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.json().error.message).toBe(`${(await getItems()).bread.n} already has a live contract with Aavin Dairy Depot`);
    const live = (await contractsList()).filter(
      (c: { it: string; vendor: string; active: boolean }) => c.it === "bread" && c.vendor === "Aavin Dairy Depot" && c.active,
    );
    expect(live).toHaveLength(1);
  });

  it("refuses a window that ends before it starts on a patch too, and 404s an unknown id", async () => {
    const id = await given.contract(app.testDb!.db, { vendorId: "VN-005", it: "oil", rate: 120, from: "2026-04-01", to: "2027-03-31" });
    expect((await patch("u3", `/contracts/${id}`, { to: "2026-01-01" })).json().error.message).toBe("A contract cannot end before it starts");
    expect((await patch("u3", "/contracts/RC-777", { rate: 1 })).json().error.message).toBe("There is no rate contract RC-777.");
  });

  it("refuses an empty patch, like vendors does", async () => {
    const vendorId = await given.vendor(app.testDb!.db, { n: "Empty Patch Traders" });
    const id = await given.contract(app.testDb!.db, { vendorId, it: "leaf", rate: 200 });
    expect((await patch("u3", `/contracts/${id}`, {})).json().error.message).toBe(`Nothing to change on ${id}`);
  });
});
