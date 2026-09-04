import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { locationItems } from "../../db/schema/index.js";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "catalog" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

type Hdrs = { authorization: string; "idempotency-key": string };
const hdr = async (id: string): Promise<Hdrs> => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const put = (url: string, headers: Hdrs, payload: Record<string, unknown>) => app.inject({ method: "PUT", url: `/api/v1${url}`, headers, payload });
const post = (url: string, headers: Hdrs, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
const del = (url: string, headers: Hdrs) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
const get = async (url: string) => { const r = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: await authHeaders(app, "u2") }); expect(r.statusCode).toBe(200); return r.json(); };

describe("catalog: prices", () => {
  it("refuses a price above the item's own printed MRP, with the exact refusal text", async () => {
    const r = await put("/prices/A/juice", await hdr("u2"), { price: 25 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe("rule");
    expect(r.json().error.message).toBe("Refused — printed MRP of ₹20 is a hard ceiling for Real Juice 200ml");
  });

  it("saves a price at or under the MRP and it is visible on GET /prices", async () => {
    const r = await put("/prices/A/juice", await hdr("u2"), { price: 19 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ result: { list: "A", it: "juice", price: 19 }, changed: ["prices"], message: "Real Juice 200ml priced at ₹19 on list A" });
    expect((await get("/prices")).A.juice).toBe(19);
  });

  it("upserts: saving the same list/item again overwrites the previous price", async () => {
    await put("/prices/B/juice", await hdr("u2"), { price: 20 });
    const r = await put("/prices/B/juice", await hdr("u2"), { price: 19 });
    expect(r.statusCode).toBe(200);
    expect(r.json().result.price).toBe(19);
    expect((await get("/prices")).B.juice).toBe(19);
  });

  it("404s on an unknown item key", async () => {
    const r = await put("/prices/A/doesnotexist", await hdr("u2"), { price: 10 });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no item doesnotexist.");
  });

  it("refuses a price of nothing — 400 at the door, the same as the screen's own guard", async () => {
    for (const price of [0, -1]) {
      const r = await put("/prices/A/juice", await hdr("u2"), { price });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.code).toBe("validation");
    }
  });
});

describe("catalog: menus", () => {
  it("adds and removes a menu item, preserving the order of the rest", async () => {
    const before = (await get("/menus")).coffee;
    expect(before).toEqual(["capp", "chai", "juice", "water", "bisc", "chips"]);

    const added = await post("/menus/coffee/items", await hdr("u2"), { it: "sand" });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toEqual({ result: { loc: "coffee", items: [...before, "sand"] }, changed: ["menu"], message: "Veg sandwich listed at Coffee Shop" });
    expect((await get("/menus")).coffee).toEqual([...before, "sand"]);

    const removed = await del("/menus/coffee/items/sand", await hdr("u2"));
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ result: { loc: "coffee", items: before }, changed: ["menu"], message: "Veg sandwich removed from Coffee Shop" });
    expect((await get("/menus")).coffee).toEqual(before);
  });

  it("422s adding an item already on the menu", async () => {
    const r = await post("/menus/coffee/items", await hdr("u2"), { it: "capp" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Cappuccino is already listed at Coffee Shop");
  });

  it("422s removing an item that is not listed", async () => {
    const r = await del("/menus/coffee/items/sand", await hdr("u2"));
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Veg sandwich is not listed at Coffee Shop");
  });

  it("404s on an unknown item key for both add and remove", async () => {
    const a = await post("/menus/coffee/items", await hdr("u2"), { it: "doesnotexist" });
    expect(a.statusCode).toBe(404);
    expect(a.json().error.message).toBe("There is no item doesnotexist.");
    const b = await del("/menus/coffee/items/doesnotexist", await hdr("u2"));
    expect(b.statusCode).toBe(404);
    expect(b.json().error.message).toBe("There is no item doesnotexist.");
  });

  it("422s adding to a location that is not an outlet", async () => {
    const r = await post("/menus/store/items", await hdr("u2"), { it: "juice" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Central Store is not an outlet");
  });

  it("lets exactly one of two concurrent adds list the item", async () => {
    // Both read "not listed" before either inserts. The insert is what arbitrates — `on conflict
    // do nothing` gives the loser no row and it reads the ordinary refusal, not a 500.
    const [h1, h2] = await Promise.all([hdr("u2"), hdr("u2")]);
    const [a, b] = await Promise.all([
      post("/menus/kiosk/items", h1, { it: "sand" }),
      post("/menus/kiosk/items", h2, { it: "sand" }),
    ]);
    expect([a.statusCode, b.statusCode].sort(), `${a.body} | ${b.body}`).toEqual([200, 422]);
    const loser = a.statusCode === 422 ? a : b;
    expect(loser.json().error.code).toBe("rule");
    expect(loser.json().error.message).toBe("Veg sandwich is already listed at Snack Kiosk");

    const rows = await app.db.select().from(locationItems).where(and(eq(locationItems.loc, "kiosk"), eq(locationItems.itemKey, "sand")));
    expect(rows.length).toBe(1);
    // The seq is computed inside the insert, so the winner still lands after everything listed.
    const kiosk = (await get("/menus")).kiosk;
    expect(kiosk[kiosk.length - 1]).toBe("sand");
    await del("/menus/kiosk/items/sand", await hdr("u2"));
  });
});

describe("catalog: role gate", () => {
  it("hides all three writes from a counter operator (404, not 403)", async () => {
    const price = await put("/prices/A/juice", await hdr("u1"), { price: 19 });
    expect(price.statusCode).toBe(404);
    const add = await post("/menus/coffee/items", await hdr("u1"), { it: "sand" });
    expect(add.statusCode).toBe(404);
    const remove = await del("/menus/coffee/items/juice", await hdr("u1"));
    expect(remove.statusCode).toBe(404);
  });
});
