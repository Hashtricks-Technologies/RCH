import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { resetDocuments, truncateAll } from "../../test/db.js";
import { availabilityOverrides, batches, items, locationItems, priceListItems, stockBalances, stockMoves } from "../../db/schema/index.js";
import type { App } from "../../app.js";

// Counted versus on/off-only kitchen finished goods: the kitchen's new product, its switch
// reaching every outlet, the sale, the kitchen's own doors refusing an on/off item by name, and
// the item drawer's Counted / On/off only move.
let app: App;
beforeAll(async () => {
  app = await buildTestApp({ schema: "onoff" });
  await app.ready();
  await truncateAll(app.testDb!.db);
  await seedTestDb(app.testDb!.db);
  // The Coffee Shop serves meals too in this file, so its counter (u1) can ring one up.
  await app.testDb!.db.insert(locationItems).values({ loc: "coffee", itemKey: "meals", seq: 99 });
  await app.testDb!.db.insert(priceListItems).values({ listId: "PL-002", itemKey: "meals", price: 95 });
});
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDocuments(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const send = async (user: string, method: "POST" | "PATCH", url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url: `/api/v1${url}`, headers: await hdr(user), ...(payload ? { payload } : {}) });
const get = async (user: string, url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: await authHeaders(app, user) });
const balance = async (loc: string, it: string): Promise<number | undefined> => {
  const [row] = await app.testDb!.db.select().from(stockBalances).where(and(eq(stockBalances.loc, loc), eq(stockBalances.itemKey, it)));
  return row?.onHand;
};
const kitchenSwitch = async (it: string) =>
  (await app.testDb!.db.select().from(availabilityOverrides).where(and(eq(availabilityOverrides.loc, "kitchen"), eq(availabilityOverrides.itemKey, it)))).length > 0;

describe("the kitchen's new product: counted or on/off only", () => {
  it("adds an on/off-only product switched on, as made to order with the kitchen as its source", async () => {
    const r = await send("u4", "POST", "/items", { name: "Masala dosa", type: "MTO", cost: 30, loc: "kitchen", sl: 0 });
    expect(r.statusCode, r.body).toBe(200);
    const { key, item } = r.json().result;
    expect(item).toMatchObject({ t: "MTO", src: "kitchen" });
    expect(item.c).toMatch(/^MT-\d+$/);
    expect(r.json().message).toBe(`Masala dosa added to the catalogue as ${item.c} - on/off only, switched on at every outlet that lists it`);
    expect(r.json().changed).toEqual(["items"]);
    expect(await kitchenSwitch(key)).toBe(false);
  });

  it("adds one switched off when the kitchen says it is not available yet", async () => {
    const r = await send("u4", "POST", "/items", { name: "Curd rice", type: "MTO", cost: 25, loc: "kitchen", avail: false });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().changed).toEqual(["items", "ovr"]);
    expect(r.json().message).toBe(`Curd rice added to the catalogue as ${r.json().result.item.c} - switched off until the kitchen turns it on`);
    expect(await kitchenSwitch(r.json().result.key)).toBe(true);
  });

  it("gives an on/off-only product no opening stock", async () => {
    const r = await send("u4", "POST", "/items", { name: "Lemon rice", type: "MTO", cost: 25, loc: "kitchen", opening: 5 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Lemon rice is on/off only - the kitchen switches it on and off, so it is not given opening stock");
  });

  it("books a counted product's 'made now' as a batch on the kitchen's rack, best-before from its shelf life", async () => {
    const r = await send("u4", "POST", "/items", { name: "Paneer puff", type: "FG", cost: 20, loc: "kitchen", sl: 10, opening: 6 });
    expect(r.statusCode, r.body).toBe(200);
    const { key, item } = r.json().result;
    expect(r.json().changed).toEqual(["items", "batch", "stock"]);
    const [b] = await app.testDb!.db.select().from(batches).where(eq(batches.itemKey, key));
    expect(b).toMatchObject({ startedQty: 6, madeQty: 6, byUser: "u4" });
    expect(b!.bestBefore.getTime() - b!.at.getTime()).toBe(10 * 3_600_000);
    expect(r.json().message).toMatch(new RegExp(`^Paneer puff added to the catalogue as ${item.c} - ${b!.id}, 6 nos made, best before `));
    const moves = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.itemKey, key));
    expect(moves.map((m) => ({ loc: m.loc, qty: m.qty, kind: m.kind, ref: m.refType }))).toEqual([{ loc: "kitchen", qty: 6, kind: "production_yield", ref: "batch" }]);
    expect(await balance("kitchen", key)).toBe(6);
  });

  it("adds a counted product with none made yet: no batch, no stock", async () => {
    const r = await send("u4", "POST", "/items", { name: "Egg puff", type: "FG", cost: 20, loc: "kitchen", opening: 0 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().changed).toEqual(["items"]);
    expect(await app.testDb!.db.select().from(batches).where(eq(batches.itemKey, r.json().result.key))).toEqual([]);
  });
});

describe("the kitchen's switch on an on/off-only product reaches every outlet", () => {
  it("switched off by the kitchen, no counter can sell it, whatever its own switch says", async () => {
    const off = await send("u4", "POST", "/availability/toggle", { loc: "kitchen", it: "meals" });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().message).toBe("Veg meals switched off at every outlet that lists it");

    const sale = await send("u1", "POST", "/bills", { loc: "coffee", tender: "Cash", lines: [{ it: "meals", qty: 1 }] });
    expect(sale.statusCode).toBe(422);
    expect(sale.json().error.message).toBe("Veg meals is not available at Coffee Shop - switched off by the kitchen");

    // The counter's own read carries the kitchen's switch, so its till previews the same answer.
    const stock = (await get("u1", "/stock")).json();
    expect(stock.ovr["kitchen:meals"]).toBe("switched off manually");
    expect(Object.keys(stock.ovr).every((k: string) => k.startsWith("coffee:") || k.startsWith("kitchen:"))).toBe(true);

    const on = await send("u4", "POST", "/availability/toggle", { loc: "kitchen", it: "meals" });
    expect(on.json().message).toBe("Veg meals switched on at every outlet that lists it");
    const sold = await send("u1", "POST", "/bills", { loc: "coffee", tender: "Cash", lines: [{ it: "meals", qty: 2 }] });
    expect(sold.statusCode, sold.body).toBe(200);
    // Made to order: selling it moves no stock.
    const moves = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.itemKey, "meals"));
    expect(moves).toEqual([]);
  });

  it("an outlet still switches it off for itself alone", async () => {
    await send("u1", "POST", "/availability/toggle", { loc: "coffee", it: "meals" });
    const sale = await send("u1", "POST", "/bills", { loc: "coffee", tender: "Cash", lines: [{ it: "meals", qty: 1 }] });
    expect(sale.json().error.message).toBe("Veg meals is not available at Coffee Shop - switched off manually");
    expect(await kitchenSwitch("meals")).toBe(false);
  });

  it("the kitchen switches only what it makes", async () => {
    const r = await send("u4", "POST", "/availability/toggle", { loc: "kitchen", it: "capp" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Cappuccino is not made at Central Kitchen");
    const fg = await send("u4", "POST", "/availability/toggle", { loc: "kitchen", it: "puff" });
    expect(fg.json().message).toBe("Veg puffs switched off at Central Kitchen");
  });
});

describe("the kitchen's doors refuse an on/off-only product by name", () => {
  it("is never ordered from the kitchen, batched or distributed", async () => {
    const order = await send("u1", "POST", "/prod-orders", { lines: [{ it: "meals", qty: 4 }] });
    expect(order.statusCode).toBe(422);
    expect(order.json().error.message).toBe("Veg meals is on/off only - the kitchen switches it on and off, so it is not ordered from the kitchen");
    const batch = await send("u4", "POST", "/batches", { it: "meals", started: 10 });
    expect(batch.json().error.message).toBe("Veg meals is on/off only - the kitchen switches it on and off, so it is not batched");
    const dist = await send("u4", "POST", "/distributions", { it: "meals", qty: 2, to: "rest" });
    expect(dist.json().error.message).toBe("Veg meals is on/off only - the kitchen switches it on and off, so it is not distributed");
  });

  it("is not dispatched on an order raised while it was still counted", async () => {
    const id = await given.prodOrder(app.testDb!.db, { from: "rest", lines: [{ it: "meals", qty: 3 }], st: "Ready" });
    const r = await send("u4", "POST", `/prod-orders/${id}/dispatch`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Veg meals is on/off only - the kitchen switches it on and off, so it is not dispatched");
  });
});

describe("Counted / On/off only on the item drawer", () => {
  it("refuses to make a counted good on/off only while anything holds or carries it, naming where", async () => {
    await given.ticket(app.testDb!.db, { from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: 4 }] });
    await given.prodOrder(app.testDb!.db, { id: "PRD-2026-0901", from: "rest", lines: [{ it: "puff", qty: 6 }], st: "Accepted" });
    const r = await send("u4", "PATCH", "/items/puff", { onOff: true });
    expect(r.statusCode).toBe(422);
    // The seeded board already carries puffs on PRD-2026-029, beside the order made here.
    expect(r.json().error.message).toMatch(/^Veg puffs cannot become on\/off only while there is stock at Snack Kiosk, Central Kitchen, Restaurant and open ticket TKT-\d+ and open kitchen orders PRD-2026-029, PRD-2026-0901 - sell, write off or finish those first$/);
    const [row] = await app.testDb!.db.select().from(items).where(eq(items.key, "puff"));
    expect(row!.type).toBe("FG");
  });

  it("moves a counted good nothing holds to on/off only and back, starting at zero, with its before on the audit event", async () => {
    const made = (await send("u4", "POST", "/items", { name: "Veg cutlet", type: "FG", cost: 15, loc: "kitchen" })).json().result.key as string;
    const on = await send("u4", "PATCH", `/items/${made}`, { onOff: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().result.item).toMatchObject({ t: "MTO", src: "kitchen" });
    expect(on.json().message).toBe("Veg cutlet is now on/off only - the kitchen's switch turns it on and off at every outlet");
    const r = await app.testDb!.pool.query<{ event: { before: { item: { t: string } } } }>(
      "select event from audit_outbox where event->>'action' = 'patchItem' order by id desc limit 1");
    expect(r.rows[0]!.event.before.item.t).toBe("FG");

    const back = await send("u4", "PATCH", `/items/${made}`, { onOff: false });
    expect(back.json().result.item).toMatchObject({ t: "FG", src: "kitchen" });
    expect(back.json().message).toBe("Veg cutlet is now counted - it starts at zero until the kitchen makes a batch");
    expect(await balance("kitchen", made)).toBeUndefined();
  });

  it("is the kitchen's call, and only for a kitchen finished good", async () => {
    const store = await send("u3", "PATCH", "/items/puff", { onOff: true });
    expect(store.statusCode).toBe(422);
    expect(store.json().error.message).toBe("Only the kitchen decides whether a finished good is counted or on/off only - ask the kitchen");
    const raw = await send("u4", "PATCH", "/items/milk", { onOff: true });
    expect(raw.json().error.message).toBe("Milk 1L (toned) is not made in the kitchen - only a kitchen finished good is counted or on/off only");
    const drink = await send("u4", "PATCH", "/items/capp", { onOff: false });
    expect(drink.json().error.message).toBe("Cappuccino is not made in the kitchen - only a kitchen finished good is counted or on/off only");
    // Asking for what it already is changes nothing but is not refused.
    const same = await send("u4", "PATCH", "/items/meals", { onOff: true });
    expect(same.json().message).toBe("Veg meals updated");
  });
});
