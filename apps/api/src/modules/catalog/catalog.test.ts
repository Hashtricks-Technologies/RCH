import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
