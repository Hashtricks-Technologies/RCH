import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import { BillsResponseSchema, SnapshotSchema, StockResponseSchema, UserMinSchema } from "@rch/contract";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "snapshot" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });
const getAs = async (userId: string, url: string) => { const r = await app.inject({ method: "GET", url, headers: await authHeaders(app, userId) }); expect(r.statusCode, r.body).toBe(200); return r.json(); };
const get = (userId: string) => getAs(userId, "/api/v1/snapshot");

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
    // revenue is not master data: the counter gets its own column and nobody else's
    const full = await get("u2");
    expect(s.dayLabels).toEqual(full.dayLabels);
    expect(s.sales.length).toBe(full.sales.length);
    expect(s.sales.every((row: number[]) => row.length === 1)).toBe(true);
    expect(s.sales.map((row: number[]) => row[0])).toEqual(full.sales.map((row: number[]) => row[1])); // coffee is column 1
    expect(full.sales.some((row: number[]) => row.length > 1)).toBe(true);
  });
  it("is fast enough on the seed", async () => {
    const h = await authHeaders(app, "u2");
    // Warm up once, then take the best of five. This pins the query shape (an N+1 over users
    // once cost eight round trips), not the p95 SLO of spec §12 — that is measured by the
    // Phase 6 load check on a quiet box. 500 ms is loose enough for five suites sharing one
    // Postgres and still an order of magnitude under a regression.
    await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: h });
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: h });
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(500);
  });
});

describe("the colleague directory is a name badge, not a contact list", () => {
  it("carries only what a screen renders — no email, employee number or phone", async () => {
    const s = await get("u2");
    expect(s.users.length).toBeGreaterThan(1);
    for (const u of s.users) {
      expect(UserMinSchema.safeParse(u).success, JSON.stringify(u)).toBe(true);
      expect(Object.keys(u).sort()).toEqual(["col", "id", "loc", "n", "r", "rl"]);
    }
  });
  it("still hands the caller their own record whole — Settings prints the employee number", async () => {
    const s = await get("u2");
    expect(s.user.emp).toBeTruthy();
    expect(s.user.e).toBeTruthy();
    expect(s.user.ph).toBeTruthy();
  });
});

describe("GET /stock", () => {
  it("answers with the three maps the snapshot carries, and nothing else", async () => {
    const [s, st] = await Promise.all([get("u3"), getAs("u3", "/api/v1/stock")]);
    expect(StockResponseSchema.safeParse(st).success).toBe(true);
    expect(st).toEqual({ stock: s.stock, rsv: s.rsv, ovr: s.ovr });
  });
  it("is scoped to a counter operator's own counter, exactly as the snapshot is", async () => {
    const [s, st] = await Promise.all([get("u1"), getAs("u1", "/api/v1/stock")]);
    expect(Object.keys(st.stock)).toEqual(["coffee"]);
    expect(Object.keys(st.rsv).every((k: string) => k.startsWith("coffee:"))).toBe(true);
    expect(st).toEqual({ stock: s.stock, rsv: s.rsv, ovr: s.ovr });
  });
});

describe("GET /bills", () => {
  it("defaults to the same week the snapshot shows", async () => {
    const [s, bills] = await Promise.all([get("u3"), getAs("u3", "/api/v1/bills")]);
    expect(BillsResponseSchema.safeParse(bills).success).toBe(true);
    expect(bills).toEqual(s.bills);
  });
  it("takes a wider window on ?days=", async () => {
    const wide = await getAs("u3", "/api/v1/bills?days=90");
    const week = await getAs("u3", "/api/v1/bills");
    expect(wide.length).toBeGreaterThanOrEqual(week.length);
  });
  it("refuses a window outside the contract rather than guessing", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/bills?days=0", headers: await authHeaders(app, "u3") });
    expect(r.statusCode).toBe(400);
  });
  it("is scoped to a counter operator's own counter", async () => {
    const bills = await getAs("u1", "/api/v1/bills?days=90");
    expect(bills.length).toBeGreaterThan(0);
    expect(bills.every((b: { loc: string }) => b.loc === "coffee")).toBe(true);
  });
});

describe("the document reads the movement chain refetches", () => {
  it("GET /requests gives a manager every request and a counter only their own outlet's", async () => {
    const all = await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u2") });
    expect(all.statusCode).toBe(200);
    expect(all.json().map((r: { id: string }) => r.id)).toEqual(["REQ-2026-0909", "REQ-2026-0910", "REQ-2026-0911", "REQ-2026-0912"]);

    const mine = await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u1") });
    expect(mine.json().map((r: { id: string }) => r.id)).toEqual(["REQ-2026-0909", "REQ-2026-0911"]);   // u1 is at coffee
  });

  it("GET /tickets gives a counter the tickets that touch their counter, either end", async () => {
    const mine = await app.inject({ method: "GET", url: "/api/v1/tickets", headers: await authHeaders(app, "u1") });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual([{ id: "TKT-0440", req: "REQ-2026-0909", from: "store", to: "coffee", lines: [{ it: "cup", qty: 500 }], st: "Issued", otp: "418327" }]);

    const other = await app.inject({ method: "GET", url: "/api/v1/tickets", headers: await authHeaders(app, "u6") });
    expect(other.json()).toEqual([]);      // u6 is at kiosk; TKT-0440 goes to coffee
  });

  it("GET /shop-asks gives a counter the asks at either end and a manager all of them", async () => {
    const mgr = await app.inject({ method: "GET", url: "/api/v1/shop-asks", headers: await authHeaders(app, "u2") });
    expect(mgr.json().map((a: { id: string }) => a.id).sort()).toEqual(["ASK-0059", "ASK-0060"]);
    const kiosk = await app.inject({ method: "GET", url: "/api/v1/shop-asks", headers: await authHeaders(app, "u6") });
    expect(kiosk.json().map((a: { id: string }) => a.id).sort()).toEqual(["ASK-0059", "ASK-0060"]);   // kiosk is one end of both
  });

  it("answers each read with exactly the slice the snapshot carries", async () => {
    const snap = (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u1") })).json();
    for (const [url, key] of [["/api/v1/requests", "req"], ["/api/v1/tickets", "tkt"], ["/api/v1/shop-asks", "shopAsks"]] as const) {
      const r = await app.inject({ method: "GET", url, headers: await authHeaders(app, "u1") });
      expect(r.json()).toEqual(snap[key]);
    }
  });
});
