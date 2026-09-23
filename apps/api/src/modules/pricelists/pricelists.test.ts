import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { items, locations } from "../../db/schema/index.js";
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

describe("PUT /outlet-prices - the manager's counter price grid", () => {
  const save = (changes: Record<string, unknown>[], user = "u2") => put(user, "/outlet-prices", { changes });
  const outletList = async (loc: string) => (await app.db.select().from(locations).where(eq(locations.key, loc)))[0]!.priceListId;
  const refusal = async (changes: Record<string, unknown>[]) => (await save(changes)).json().error.message as string;

  it("gives a counter on a shared list a copy of its own, so the other counter keeps its prices", async () => {
    expect(await outletList("kiosk")).toBe("PL-001");
    expect(await outletList("rest")).toBe("PL-001");
    const r = await save([{ loc: "kiosk", it: "juice", price: 15 }]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      result: { changes: 1, outlets: ["kiosk"] },
      changed: ["prices", "priceLists", "locations"],
      message: "1 change saved at Snack Kiosk",
    });

    const own = await outletList("kiosk");
    expect(own).not.toBe("PL-001");
    expect(await outletList("rest")).toBe("PL-001");
    const prices = (await get("u2", "/prices")).json();
    expect(prices["PL-001"].juice).toBe(18);
    // A copy, not a fresh start: everything else the kiosk charged comes with it.
    expect(prices[own!]).toEqual({ ...prices["PL-001"], juice: 15 });
    const lists = (await get("u2", "/price-lists")).json() as { id: string; name: string }[];
    expect(lists.find((l) => l.id === own)?.name).toBe("Snack Kiosk prices");

    // The till reads the kiosk's own list from here on.
    const bill = await app.inject({
      method: "POST", url: "/api/v1/bills", headers: await hdr("u6"),
      payload: { loc: "kiosk", tender: "Cash", lines: [{ it: "juice", qty: 1 }] },
    });
    expect(bill.statusCode, bill.body).toBe(200);
    expect(bill.json().result.lines).toEqual([{ it: "juice", qty: 1, rate: 15 }]);
  });

  it("prices a counter already on its own list in place, and records one audit event with the cells as they stood", async () => {
    const own = await outletList("kiosk");
    const r = await save([{ loc: "kiosk", it: "juice", price: 16 }, { loc: "kiosk", it: "puff", listed: false }]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ changed: ["prices", "menu"], message: "2 changes saved at Snack Kiosk" });
    expect(await outletList("kiosk")).toBe(own);
    expect((await get("u2", "/menus")).json().kiosk).not.toContain("puff");

    const ev = await app.testDb!.pool.query<{ event: { before: unknown; outcome: string } }>(
      "select event from audit_outbox where event->>'action' = 'saveOutletPrices' order by id desc limit 1");
    expect(ev.rows[0]!.event.outcome).toBe("done");
    expect(ev.rows[0]!.event.before).toEqual({ changes: [
      { loc: "kiosk", it: "juice", price: 15, listed: true },
      { loc: "kiosk", it: "puff", price: 25, listed: true },
    ] });

    // And back on again, priced already.
    const back = await save([{ loc: "kiosk", it: "puff", listed: true }]);
    expect(back.statusCode, back.body).toBe(200);
    expect((await get("u2", "/menus")).json().kiosk).toContain("puff");
  });

  it("refuses the whole batch on one bad cell, saving nothing", async () => {
    const before = (await get("u2", "/prices")).json();
    expect(await refusal([{ loc: "rest", it: "chips", price: 19 }, { loc: "rest", it: "milk", price: 60 }]))
      .toBe("Refused - Milk 1L (toned) is a raw material and is never sold at a counter");
    expect((await get("u2", "/prices")).json()).toEqual(before);
    expect(await outletList("rest")).toBe("PL-001");
  });

  it("refuses a price of nothing, a raw material, packing, a retired item, a duplicate and a no-op", async () => {
    expect(await refusal([{ loc: "rest", it: "sand", price: 0 }])).toBe("Enter a price greater than zero for Veg sandwich at Restaurant");
    expect(await refusal([{ loc: "rest", it: "milk", price: 60 }])).toBe("Refused - Milk 1L (toned) is a raw material and is never sold at a counter");
    expect(await refusal([{ loc: "rest", it: "box", listed: true }])).toBe("Refused - Snack box, kraft is packing and is never sold at a counter");
    expect(await refusal([{ loc: "rest", it: "sand", price: 40 }, { loc: "rest", it: "sand", listed: false }]))
      .toBe("Refused - Veg sandwich at Restaurant is in this save twice");
    expect(await refusal([{ loc: "rest", it: "sand", price: 45, listed: true }]))
      .toBe("Nothing to save - every price and switch is already as you set it");
    expect((await save([{ loc: "rest", it: "nope", price: 4 }])).json().error).toMatchObject({ code: "not_found", message: "There is no item nope." });
    expect((await save([{ loc: "nowhere", it: "sand", price: 4 }])).json().error).toMatchObject({ code: "not_found", message: "There is no location nowhere." });

    await app.db.update(items).set({ active: false }).where(eq(items.key, "salad"));
    expect(await refusal([{ loc: "rest", it: "salad", price: 50 }])).toBe("Refused - Garden salad is retired and cannot be priced or sold");
    await app.db.update(items).set({ active: true }).where(eq(items.key, "salad"));
  });

  it("refuses the store, a closed outlet, and a body that changes nothing at all", async () => {
    expect(await refusal([{ loc: "store", it: "sand", price: 40 }])).toBe("Central Store is not an outlet");
    await app.db.update(locations).set({ active: false }).where(eq(locations.key, "rest"));
    expect(await refusal([{ loc: "rest", it: "sand", price: 40 }])).toBe("Refused - Restaurant is closed");
    await app.db.update(locations).set({ active: true }).where(eq(locations.key, "rest"));
    expect((await save([{ loc: "rest", it: "sand" }])).statusCode).toBe(400);
    expect((await put("u2", "/outlet-prices", { changes: [] })).statusCode).toBe(400);
  });

  it("will not switch a counter on with no price there, and starts a list for an outlet that had none", async () => {
    await app.db.update(locations).set({ priceListId: null }).where(eq(locations.key, "rest"));
    expect(await refusal([{ loc: "rest", it: "bisc", listed: true }])).toBe("Refused - give Marie biscuit 120g a price at Restaurant before selling it there");

    const r = await save([{ loc: "rest", it: "bisc", price: 29, listed: true }]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().changed).toEqual(["prices", "menu", "priceLists", "locations"]);
    const own = await outletList("rest");
    expect(own).not.toBeNull();
    expect((await get("u2", "/prices")).json()[own!]).toEqual({ bisc: 29 });
    expect((await get("u2", "/menus")).json().rest).toContain("bisc");
  });

  it("leaves the last outlet on a shared list where it is, when every sharer is repriced at once", async () => {
    const shared = (await post("u2", "/price-lists", { name: "Pair", cloneFrom: "coffee" })).json().result.id as string;
    await app.db.update(locations).set({ priceListId: shared }).where(eq(locations.key, "rest"));
    await app.db.update(locations).set({ priceListId: shared }).where(eq(locations.key, "coffee"));
    const r = await save([{ loc: "rest", it: "chai", price: 21 }, { loc: "coffee", it: "chai", price: 26 }]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().message).toBe("2 changes saved at Coffee Shop and Restaurant");
    const [coffee, rest] = [await outletList("coffee"), await outletList("rest")];
    expect(new Set([coffee, rest]).size).toBe(2);
    expect([coffee, rest]).toContain(shared);
    const prices = (await get("u2", "/prices")).json();
    expect(prices[coffee!].chai).toBe(26);
    expect(prices[rest!].chai).toBe(21);
  });

  it("is a manager-only door", async () => {
    expect((await save([{ loc: "coffee", it: "juice", price: 19 }], "u1")).statusCode).toBe(404);
  });
});
