import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import { SnapshotSchema } from "@rch/contract";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "snapshot" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });
const get = async (userId: string) => { const r = await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, userId) }); expect(r.statusCode).toBe(200); return r.json(); };

describe("GET /snapshot", () => {
  it("validates against the contract and carries the caller", async () => {
    const s = await get("u2");
    expect(SnapshotSchema.safeParse(s).success).toBe(true);
    expect(s.user.id).toBe("u2");
  });
  it("master data equals the fixtures", async () => {
    const s = await get("u2");
    expect(s.items).toEqual(FX.IT);
    expect(s.locations).toEqual(FX.LOC);
    expect(s.recipes).toEqual(FX.RCP);
    expect(s.prices).toEqual(FX.PL);
    expect(s.menu).toEqual(FX.MENU);
    expect(s.users.map((u: { id: string }) => u.id).sort()).toEqual(FX.USERS.map((u) => u.id).sort());
  });
  it("stock, reservations and overrides come from the ledger", async () => {
    const s = await get("u3");
    for (const [loc, byItem] of Object.entries(FX.seedStock)) for (const [it, q] of Object.entries(byItem)) expect(s.stock[loc][it], `${loc}/${it}`).toBe(q);
    expect(s.rsv).toEqual(FX.seedRsv());
    expect(s.ovr).toEqual({});
  });
  it("a counter operator sees only their own location", async () => {
    const s = await get("u1"); // Kavitha, coffee
    expect(Object.keys(s.stock)).toEqual(["coffee"]);
    expect(Object.keys(s.menu)).toEqual(["coffee"]);
    expect(s.req.every((r: { from: string }) => r.from === "coffee")).toBe(true);
    expect(s.tkt.every((t: { from: string; to: string }) => t.from === "coffee" || t.to === "coffee")).toBe(true);
    expect(s.bills.every((b: { loc: string }) => b.loc === "coffee")).toBe(true);
    // master data is never scoped: prices for both lists, every item, every location
    expect(Object.keys(s.items).length).toBe(Object.keys(FX.IT).length);
  });
  it("is fast enough on the seed", async () => {
    const h = await authHeaders(app, "u2");
    // Warm up once, then take the best of five: the budget is the query cost, not
    // scheduler noise from the other test files (and their Argon2 hashing) running alongside.
    await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: h });
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: h });
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(150);
  });
});
