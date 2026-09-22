import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { locations } from "../../db/schema/index.js";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "pricelists" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

type Hdrs = { authorization: string; "idempotency-key": string };
const hdr = async (id: string): Promise<Hdrs> => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) });
const put = async (user: string, url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: `/api/v1${url}`, headers: await hdr(user), payload });
const del = async (user: string, url: string) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers: await hdr(user) });
const get = async (user: string, url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: await authHeaders(app, user) });

describe("POST /price-lists", () => {
  it("clones the source outlet's prices into a new, inactive list", async () => {
    const r = await post("u2", "/price-lists", { name: "Weekend Rates", cloneFrom: "coffee" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toEqual({ id: "PL-003", name: "Weekend Rates", outlets: [] });
    expect(b.changed).toEqual(["priceLists", "prices"]);
    expect(b.message).toBe("Weekend Rates created, cloned from Coffee Shop's prices");

    // Cloned, not linked: the new list starts with coffee's own prices as of right now.
    const prices = (await get("u2", "/prices")).json();
    expect(prices["PL-003"]).toEqual(prices["PL-002"]);

    // Still on the old list - creating a list never switches an outlet onto it.
    const [row] = await app.db.select().from(locations).where(eq(locations.key, "coffee"));
    expect(row?.priceListId).toBe("PL-002");
  });

  it("creates an empty list when no source is named - the only way a first list is ever made", async () => {
    // A hospital that has just opened its first outlet is on no list, so there is nothing to
    // clone. While `cloneFrom` was required, the *first* price list was the one list nobody
    // could create: every outlet the form could offer answered "has no price list to clone".
    const r = await post("u2", "/price-lists", { name: "Opening Prices" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toEqual({ id: "PL-004", name: "Opening Prices", outlets: [] });
    expect(b.message).toBe("Opening Prices created with no prices on it yet - price its products from an outlet's own page");
    // Empty, not absent: the list exists and carries no price row at all.
    const lists = (await get("u2", "/price-lists")).json() as { id: string }[];
    expect(lists.map((l) => l.id)).toContain("PL-004");
    expect((await get("u2", "/prices")).json()["PL-004"]).toBeUndefined();
  });

  it("refuses a blank name, and a source outlet that is not an outlet", async () => {
    expect((await post("u2", "/price-lists", { name: "   ", cloneFrom: "rest" })).json().error.message)
      .toBe("Give the price list a name before saving");
    expect((await post("u2", "/price-lists", { name: "Store Rates", cloneFrom: "store" })).json().error.message)
      .toBe("Central Store is not an outlet");
  });

  it("refuses cloning from an outlet with no active list", async () => {
    await app.db.update(locations).set({ priceListId: null }).where(eq(locations.key, "kiosk"));
    expect((await post("u2", "/price-lists", { name: "Kiosk Copy", cloneFrom: "kiosk" })).json().error.message)
      .toBe("Snack Kiosk has no price list to clone");
    // restore for the tests below, which assume the seeded topology
    await app.db.update(locations).set({ priceListId: "PL-001" }).where(eq(locations.key, "kiosk"));
  });

  it("is a manager-only door", async () => {
    expect((await post("u1", "/price-lists", { name: "X", cloneFrom: "coffee" })).statusCode).toBe(404);
  });
});

describe("PUT /outlets/:loc/price-list", () => {
  it("switches the outlet, refuses when nothing would change, and refuses an unknown list", async () => {
    const created = (await post("u2", "/price-lists", { name: "Switch Target", cloneFrom: "rest" })).json().result;
    const r = await put("u2", "/outlets/coffee/price-list", { listId: created.id });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: { loc: "coffee", listId: created.id }, changed: ["priceLists", "prices", "locations"], message: `Coffee Shop switched to ${created.name}` });

    expect((await put("u2", "/outlets/coffee/price-list", { listId: created.id })).json().error.message)
      .toBe(`Nothing to save - Coffee Shop is already on Switch Target`);
    expect((await put("u2", "/outlets/coffee/price-list", { listId: "PL-999" })).json().error)
      .toMatchObject({ code: "not_found", message: "There is no price list PL-999." });
    expect((await put("u2", "/outlets/store/price-list", { listId: created.id })).json().error.message)
      .toBe("Central Store is not an outlet");
  });

  it("is a manager-only door", async () => {
    expect((await put("u1", "/outlets/coffee/price-list", { listId: "PL-001" })).statusCode).toBe(404);
  });
});

describe("DELETE /price-lists/:id", () => {
  it("refuses a list still active at an outlet, naming every outlet on it", async () => {
    const r = await del("u2", "/price-lists/PL-001");
    expect(r.json().error).toMatchObject({ code: "rule" });
    expect(r.json().error.message).toBe("Refused - List A is still used by Snack Kiosk, Restaurant - switch them to another list first");
  });

  it("refuses an unknown list", async () => {
    expect((await del("u2", "/price-lists/PL-999")).json().error).toMatchObject({ code: "not_found", message: "There is no price list PL-999." });
  });

  it("deletes a list once no outlet is on it, taking its price rows with it", async () => {
    const created = (await post("u2", "/price-lists", { name: "Disposable", cloneFrom: "rest" })).json().result;
    const r = await del("u2", `/price-lists/${created.id}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ result: { id: created.id }, changed: ["priceLists"], message: "Disposable deleted" });
    expect((await get("u2", "/prices")).json()[created.id]).toBeUndefined();
  });

  it("is a manager-only door", async () => {
    expect((await del("u1", "/price-lists/PL-001")).statusCode).toBe(404);
  });
});
