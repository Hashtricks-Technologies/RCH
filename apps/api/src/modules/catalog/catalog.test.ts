import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { documentHistory, locationItems, locations, priceLists, stockBalances, stockMoves } from "../../db/schema/index.js";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { warmPool } from "../../test/db.js";
import type { App } from "../../app.js";
import { nextItemCode } from "@rch/domain";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "catalog" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

type Hdrs = { authorization: string; "idempotency-key": string };
const hdr = async (id: string): Promise<Hdrs> => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const put = (url: string, headers: Hdrs, payload: Record<string, unknown>) => app.inject({ method: "PUT", url: `/api/v1${url}`, headers, payload });
const post = (url: string, headers: Hdrs, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/v1${url}`, headers, payload });
const del = (url: string, headers: Hdrs) => app.inject({ method: "DELETE", url: `/api/v1${url}`, headers });
// ---- item patch ----
const patch = (url: string, headers: Hdrs, payload: Record<string, unknown>) => app.inject({ method: "PATCH", url: `/api/v1${url}`, headers, payload });
const get = async (url: string) => { const r = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: await authHeaders(app, "u2") }); expect(r.statusCode).toBe(200); return r.json(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("catalog: prices", () => {
  it("saves a price above the item's own printed MRP - the till caps the charge, not the list", async () => {
    const r = await put("/prices/PL-001/juice", await hdr("u2"), { price: 25 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().message).toBe("Real Juice 200ml priced at ₹25 on list PL-001");
    expect((await get("/prices"))["PL-001"].juice).toBe(25);
  });

  it("saves a price at or under the MRP and it is visible on GET /prices", async () => {
    const r = await put("/prices/PL-001/juice", await hdr("u2"), { price: 19 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ result: { list: "PL-001", it: "juice", price: 19 }, changed: ["prices"], message: "Real Juice 200ml priced at ₹19 on list PL-001" });
    expect((await get("/prices"))["PL-001"].juice).toBe(19);
  });

  it("upserts: saving the same list/item again overwrites the previous price", async () => {
    await put("/prices/PL-002/juice", await hdr("u2"), { price: 20 });
    const r = await put("/prices/PL-002/juice", await hdr("u2"), { price: 19 });
    expect(r.statusCode).toBe(200);
    expect(r.json().result.price).toBe(19);
    expect((await get("/prices"))["PL-002"].juice).toBe(19);
  });

  it("404s on an unknown item key", async () => {
    const r = await put("/prices/PL-001/doesnotexist", await hdr("u2"), { price: 10 });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no item doesnotexist.");
  });

  it("refuses a price of nothing - 400 at the door, the same as the screen's own guard", async () => {
    for (const price of [0, -1]) {
      const r = await put("/prices/PL-001/juice", await hdr("u2"), { price });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.code).toBe("validation");
    }
  });

  it("404s on an unknown price list", async () => {
    const r = await put("/prices/PL-999/juice", await hdr("u2"), { price: 19 });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no price list PL-999.");
  });

  it("turns a list deleted mid-save into the same refusal, never a raw 500", async () => {
    // `savePrice` checks the list exists unlocked, then inserts - a list stays editable at any
    // time, active or not, so a manager can delete an unattached one in the moment between.
    // The insert's own foreign key is what actually catches it; this proves it comes out as the
    // operator's sentence, not `deleteUserTx`'s uncaught cousin.
    await warmPool(app.testDb!, 2);
    await app.db.insert(priceLists).values({ id: "PL-RACE", name: "Race List" });
    const holder = app.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from price_lists where id = 'PL-RACE' for update`);
      await sleep(300);
      await tx.execute(sql`delete from price_lists where id = 'PL-RACE'`);
    });
    await sleep(50);
    const raced = put("/prices/PL-RACE/juice", await hdr("u2"), { price: 10 });
    const [r] = await Promise.all([raced, holder]);

    expect(r.statusCode, r.body).toBe(404);
    expect(r.json().error.message).toBe("There is no price list PL-RACE.");
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

  it("refuses a raw material and a packing line in the price grid's own words", async () => {
    const raw = await post("/menus/coffee/items", await hdr("u2"), { it: "milk" });
    expect(raw.statusCode).toBe(422);
    expect(raw.json().error.message).toBe("Refused - Milk 1L (toned) is a raw material and is never sold at a counter");
    const pack = await post("/menus/coffee/items", await hdr("u2"), { it: "box" });
    expect(pack.json().error.message).toBe("Refused - Snack box, kraft is packing and is never sold at a counter");
    expect((await get("/menus")).coffee).not.toContain("milk");
  });

  it("refuses a product the outlet's list has no price for, and one at an outlet on no list", async () => {
    const made = await post("/items", await hdr("u3"), { name: "Menu unpriced tea", unit: "nos", type: "MTO", cost: 5, loc: "store", opening: 0 });
    const k = made.json().result.key as string;
    const r = await post("/menus/coffee/items", await hdr("u2"), { it: k });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Refused - give Menu unpriced tea a price at Coffee Shop before selling it there");

    // Priced on the kiosk's list, not the coffee shop's: the kiosk takes it, the coffee shop still refuses.
    expect((await put(`/prices/PL-001/${k}`, await hdr("u2"), { price: 15 })).statusCode).toBe(200);
    expect((await post("/menus/coffee/items", await hdr("u2"), { it: k })).statusCode).toBe(422);
    expect((await post("/menus/kiosk/items", await hdr("u2"), { it: k })).statusCode).toBe(200);
    await del(`/menus/kiosk/items/${k}`, await hdr("u2"));

    await app.db.update(locations).set({ priceListId: null }).where(eq(locations.key, "kiosk"));
    try {
      const none = await post("/menus/kiosk/items", await hdr("u2"), { it: "sand" });
      expect(none.statusCode).toBe(422);
      expect(none.json().error.message).toBe("Refused - give Veg sandwich a price at Snack Kiosk before selling it there");
    } finally {
      await app.db.update(locations).set({ priceListId: "PL-001" }).where(eq(locations.key, "kiosk"));
    }
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
    // Both read "not listed" before either inserts. The insert is what arbitrates - `on conflict
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
    const price = await put("/prices/PL-001/juice", await hdr("u1"), { price: 19 });
    expect(price.statusCode).toBe(404);
    const add = await post("/menus/coffee/items", await hdr("u1"), { it: "sand" });
    expect(add.statusCode).toBe(404);
    const remove = await del("/menus/coffee/items/juice", await hdr("u1"));
    expect(remove.statusCode).toBe(404);
  });
});

describe("catalog: a new product on the master", () => {
  const base = { name: "Cold coffee premix 1kg", unit: "kg", type: "RAW" as const, cost: 320, loc: "store" as const, opening: 0 };

  /** The codes the master already holds, for predicting the one the server will give next. */
  const codes = async (): Promise<string[]> => Object.values(await get("/items") as Record<string, { c: string }>).map((i) => i.c);

  it("adds an item, chooses its key, and applies the store's own defaults", async () => {
    const expected = nextItemCode("RAW", await codes());
    const r = await post("/items", await hdr("u3"), base);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.key).toBe("coldcoffeepr");                // the name, slugged and cut to 12
    expect(b.result.item).toMatchObject({ n: base.name, u: "kg", t: "RAW", g: "Other", hsn: "2106", gst: 5, cost: 320, c: expected });
    expect(expected).toMatch(/^RM-1\d{3}$/);
    expect(b.result.item.mrp).toBeUndefined();
    expect(b.changed).toEqual(["items"]);
    expect(b.message).toBe(`Cold coffee premix 1kg added to the catalogue as ${expected}`);
    expect((await get("/items"))[b.result.key]).toMatchObject({ n: base.name });
  });

  it("books opening stock as an opening move, and says where", async () => {
    // At the central store. A raw line the kitchen opens is used as it lands instead
    // (`modules/wastage/wastage.test.ts`).
    const r = await post("/items", await hdr("u3"), { ...base, name: "Store premix 2kg", loc: "store", opening: 12 });
    const b = r.json();
    expect(b.changed).toEqual(["items", "stock"]);
    expect(b.message).toBe(`Store premix 2kg added to the catalogue as ${b.result.item.c} with 12.000 kg at Central Store`);
    const moves = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.itemKey, b.result.key));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: "opening", loc: "store", qty: 12, refType: "item" });
  });

  it("carries no stock-request source unless one is given, and carries it when one is", async () => {
    const none = (await post("/items", await hdr("u3"), { ...base, name: "No source given 1kg" })).json();
    expect(none.result.item.src).toBeUndefined();
    const given = (await post("/items", await hdr("u4"), { ...base, name: "Kitchen-sourced 1kg", loc: "kitchen", src: "kitchen" })).json();
    expect(given.result.item.src).toBe("kitchen");
  });

  it("leaves no balance row at all when nothing is booked in", async () => {
    // A row's presence means "this location carries the line" (M12); a new item nobody has
    // bought yet carries nowhere, and the store's list shows it because it unions the catalogue.
    const b = (await post("/items", await hdr("u3"), { ...base, name: "Nothing yet 1kg" })).json();
    expect(await app.testDb!.db.select().from(stockBalances).where(eq(stockBalances.itemKey, b.result.key))).toHaveLength(0);
  });

  it("de-duplicates a key with a numeric suffix, and still refuses a duplicate name", async () => {
    // Two different names that slug the same way inside twelve characters - which is exactly
    // the case the advisory lock on the slug exists for.
    const one = (await post("/items", await hdr("u3"), { ...base, name: "Masala tea premix A" })).json();
    const two = (await post("/items", await hdr("u3"), { ...base, name: "Masala tea premix B" })).json();
    expect(one.result.key).toBe("masalateapre");
    expect(two.result.key).toBe("masalateapre2");             // the slug is taken, so a suffix
    const dup = await post("/items", await hdr("u3"), { ...base, name: "masala TEA premix a" });
    expect(dup.statusCode).toBe(422);
    expect(dup.json().error.message).toBe("masala TEA premix a is already in the catalogue");
  });

  it("refuses a nameless product and one that costs nothing", async () => {
    expect((await post("/items", await hdr("u3"), { ...base, name: "  " })).json().error.message).toBe("Give the product a name");
    expect((await post("/items", await hdr("u3"), { ...base, name: "Free stuff", cost: 0 })).json().error.message).toBe("Cost must be more than zero");
  });

  it("books at the caller's own shelf and nowhere else", async () => {
    expect((await post("/items", await hdr("u4"), { ...base, name: "Wrong shelf 1", loc: "store" })).json().error.message)
      .toBe("A new product's opening stock is booked at Central Kitchen");
    expect((await post("/items", await hdr("u3"), { ...base, name: "Wrong shelf 2", loc: "kitchen" })).json().error.message)
      .toBe("A new product's opening stock is booked at Central Store");
    expect((await post("/items", await hdr("u5"), { ...base, name: "Buyer's own" })).statusCode).toBe(200);
    for (const u of ["u1", "u2"]) {
      expect((await post("/items", await hdr(u), { ...base, name: "Not yours" })).statusCode).toBe(404);
    }
  });

  it("assigns the code from the type's own series, and ignores a code the caller typed", async () => {
    const before = await codes();
    const pack = (await post("/items", await hdr("u3"), { ...base, name: "Code series pack", type: "PACK", code: "MINE-1" })).json();
    expect(pack.result.item.c).toBe(nextItemCode("PACK", before));
    expect(pack.result.item.c).toMatch(/^PK-2\d{3}$/);
    const fg = (await post("/items", await hdr("u4"), { ...base, name: "Code series fg", type: "FG", loc: "kitchen" })).json();
    expect(fg.result.item.c).toBe(nextItemCode("FG", before));
    const pack2 = (await post("/items", await hdr("u5"), { ...base, name: "Code series pack two", type: "PACK" })).json();
    expect(Number(pack2.result.item.c.slice(3))).toBe(Number(pack.result.item.c.slice(3)) + 1);
  });

  it("refuses an MRP item with no printed price, in the new-product form's own words", async () => {
    for (const mrp of [undefined, 0]) {
      const r = await post("/items", await hdr("u3"), { ...base, name: "No MRP given", type: "MRP", ...(mrp === undefined ? {} : { mrp }) });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.message).toBe("An MRP item needs the price printed on its pack");
    }
    const ok = await post("/items", await hdr("u3"), { ...base, name: "MRP given", type: "MRP", mrp: 400 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().result.item.mrp).toBe(400);
  });

  it("lets each desk add only the types its new-product form offers", async () => {
    const add = async (u: string, type: string, loc = "store") =>
      post("/items", await hdr(u), { ...base, name: `Desk type ${u} ${type}`, type, loc, ...(type === "MRP" ? { mrp: 400 } : {}) });
    for (const t of ["RAW", "PACK", "MRP", "FG", "MTO"]) expect((await add("u3", t)).statusCode).toBe(200);
    for (const t of ["FG", "MTO", "RAW"]) expect((await add("u4", t, "kitchen")).statusCode).toBe(200);
    for (const t of ["RAW", "PACK", "MRP"]) expect((await add("u5", t)).statusCode).toBe(200);

    const kitchenMrp = await add("u4", "MRP", "kitchen");
    expect(kitchenMrp.statusCode).toBe(422);
    expect(kitchenMrp.json().error.message)
      .toBe("Refused - the kitchen does not add printed-price (MRP) goods to the item master, only finished goods, made-to-order items and raw materials");
    expect((await add("u4", "PACK", "kitchen")).statusCode).toBe(422);
    const buyerFg = await add("u5", "FG");
    expect(buyerFg.json().error.message)
      .toBe("Refused - procurement does not add finished goods to the item master, only raw materials, packaging and printed-price (MRP) goods");
    expect((await add("u5", "MTO")).statusCode).toBe(422);
    expect(Object.values(await get("/items") as Record<string, { n: string }>).filter((i) => i.n === "Desk type u5 FG")).toHaveLength(0);
  });

  it("gives two products of one type created at once two different codes", async () => {
    // Both read the same highest code unless the series lock makes the second wait for the first.
    await warmPool(app.testDb!, 2);
    const [h1, h2] = await Promise.all([hdr("u3"), hdr("u5")]);
    const both = await Promise.all([
      post("/items", h1, { ...base, name: "Race code one", type: "PACK" }),
      post("/items", h2, { ...base, name: "Race code two", type: "PACK" }),
    ]);
    expect(both.map((r) => r.statusCode), both.map((r) => r.body).join(" | ")).toEqual([200, 200]);
    const got = both.map((r) => r.json().result.item.c as string);
    expect(new Set(got).size).toBe(2);
  });

  it("adds one item, not two, when the same name is submitted twice at once", async () => {
    await warmPool(app.testDb!, 2);
    const body = { ...base, name: "Twice premix 1kg" };
    const both = await Promise.all([post("/items", await hdr("u3"), body), post("/items", await hdr("u3"), body)]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });
});

// ---- item patch ----
describe("PATCH /items/:it", () => {
  const base = { unit: "nos", type: "MRP" as const, cost: 10, mrp: 12, loc: "store" as const, opening: 0 };
  /** A fresh line on the master for each case - this file seeds once and never resets, so a
   *  case that reused a name would be testing the previous case's leftovers. */
  const make = async (name: string, over: Record<string, unknown> = {}): Promise<string> => {
    const r = await post("/items", await hdr("u3"), { ...base, name, ...over });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().result.key as string;
  };

  it("lets the manager change mrp, cost and gst", async () => {
    const k = await make("Patch commercial", { mrp: 20 });
    const r = await patch(`/items/${k}`, await hdr("u2"), { mrp: 24, cost: 12.5, gst: 12 });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ key: k, item: { mrp: 24, cost: 12.5, gst: 12 } });
    expect(b.changed).toEqual(["items"]);
    expect(b.message).toBe("Patch commercial updated");
  });

  it("lets the store, the buyer and the kitchen change the name, group, HSN, reorder level, shelf life and stock-request source", async () => {
    for (const [u, who] of [["u3", "store"], ["u5", "buyer"], ["u4", "kitchen"]]) {
      const k = await make(`Patch operational ${who}`);
      const r = await patch(`/items/${k}`, await hdr(u), { n: `Patch operational ${who} renamed`, grp: "Grocery", hsn: "2202", rl: 12.5, sl: 6, src: "kitchen" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().result.item).toMatchObject({ n: `Patch operational ${who} renamed`, g: "Grocery", hsn: "2202", rl: 12.5, sl: 6, src: "kitchen" });
      expect(r.json().message).toBe(`Patch operational ${who} renamed updated`);
    }
  });

  it("lets a patched shelf life fall back to none, the same way create-item treats a blank box", async () => {
    const k = await make("Patch shelf life", { sl: 4 });
    expect((await get("/items"))[k]).toMatchObject({ sl: 4 });
    const r = await patch(`/items/${k}`, await hdr("u4"), { sl: 0 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.item.sl).toBeUndefined();
  });

  it("refuses the manager an operational field and the store a commercial one, each in its own words", async () => {
    const k = await make("Patch wrong desk");
    const m = await patch(`/items/${k}`, await hdr("u2"), { rl: 5 });
    expect(m.statusCode).toBe(422);
    expect(m.json().error.message).toBe("The store, the buyer and the kitchen keep an item's name, group, HSN, reorder level, shelf life and stock-request source - ask one of them");
    const s = await patch(`/items/${k}`, await hdr("u3"), { cost: 99 });
    expect(s.statusCode).toBe(422);
    expect(s.json().error.message).toBe("Only the outlet manager changes an item's price, cost or GST - ask them to make that change");
    expect((await get("/items"))[k]).toMatchObject({ rl: 0, cost: 10 });
  });

  it("lets the manager set a display name, clear it with a blank, and refuses it to every other desk", async () => {
    const k = await make("Britannia 50/50 test");
    const set = await patch(`/items/${k}`, await hdr("u2"), { dn: "  50/50-5 " });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().result.item).toMatchObject({ n: "Britannia 50/50 test", dn: "50/50-5" });
    expect((await get("/items"))[k]).toMatchObject({ dn: "50/50-5" });
    for (const u of ["u3", "u4", "u5"]) {
      const r = await patch(`/items/${k}`, await hdr(u), { dn: "Mine" });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.message).toBe("Only the outlet manager sets the name the counters read on the till - ask them to make that change");
    }
    const cleared = await patch(`/items/${k}`, await hdr("u2"), { dn: "  " });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().result.item.dn).toBeUndefined();
  });

  it("is absent for a counter operator", async () => {
    // A till sells the master; it does not edit it. 404, like every module a role cannot see.
    expect((await patch("/items/juice", await hdr("u1"), { rl: 5 })).statusCode).toBe(404);
    expect((await patch("/items/juice", await hdr("u6"), { active: false })).statusCode).toBe(404);
  });

  it("refuses an empty patch", async () => {
    const k = await make("Patch nothing");
    const r = await patch(`/items/${k}`, await hdr("u3"), {});
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Nothing to change on Patch nothing");
  });

  it("404s an item that is not on the master", async () => {
    const r = await patch("/items/doesnotexist", await hdr("u3"), { rl: 5 });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no item doesnotexist.");
  });

  it("allows an MRP below a list price - the till charges the new MRP instead", async () => {
    const k = await make("Patch mrp floor", { mrp: 30 });
    await put(`/prices/PL-001/${k}`, await hdr("u2"), { price: 22 });
    await put(`/prices/PL-002/${k}`, await hdr("u2"), { price: 26 });
    const r = await patch(`/items/${k}`, await hdr("u2"), { mrp: 24 });
    expect(r.statusCode, r.body).toBe(200);
    expect((await get("/items"))[k].mrp).toBe(24);
  });

  it("allows an MRP above every list price", async () => {
    const k = await make("Patch mrp headroom", { mrp: 30 });
    await put(`/prices/PL-001/${k}`, await hdr("u2"), { price: 22 });
    const r = await patch(`/items/${k}`, await hdr("u2"), { mrp: 40 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.item.mrp).toBe(40);
  });

  it("refuses to clear an MRP - the ceiling has no clearing door", async () => {
    // Zero is what an emptied number box sends, and it would take away both the till's hard
    // ceiling and the floor a goods receipt judges a delivery against, with nothing on the
    // record to say it happened. The drawer never sends one; this is what happens if anything
    // does. An item that carries a printed MRP keeps one.
    const k = await make("Patch mrp clearing", { mrp: 30 });
    const r = await patch(`/items/${k}`, await hdr("u2"), { mrp: 0 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Give the printed MRP a value - an item that carries one keeps it");
    expect((await get("/items"))[k].mrp).toBe(30);
  });

  it("refuses a negative reorder level, and fills a blank HSN or group with the store's defaults", async () => {
    const k = await make("Patch levels and blanks", { hsn: "0401", grp: "Dairy" });
    const bad = await patch(`/items/${k}`, await hdr("u3"), { rl: -1 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toBe("Reorder level cannot be negative");
    // A blank box falls back to what `createItem` applies, rather than leaving an item with no
    // HSN code to put on a bill or no group for a picker to sort it under.
    const r = await patch(`/items/${k}`, await hdr("u3"), { hsn: "  ", grp: "" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.item).toMatchObject({ hsn: "2106", g: "Other" });
  });

  it("does not say a line was retired or restored when it never crossed", async () => {
    // `active: true` on a line that was already live has restored nothing. A history row saying
    // it did - and a toast reading "back in the catalogue" for a product that never left - is a
    // record of an event that did not happen. The other fields still land, so it reads Updated.
    const k = await make("Patch no crossing");
    const r = await patch(`/items/${k}`, await hdr("u3"), { active: true, hsn: "2202" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().message).toBe("Patch no crossing updated");
    expect(r.json().result.item).toMatchObject({ hsn: "2202", active: true });
    const rows = await app.testDb!.db.select().from(documentHistory)
      .where(and(eq(documentHistory.docType, "item"), eq(documentHistory.docId, k)));
    expect(rows.map((x) => x.status)).toEqual(["Updated"]);
  });

  it("refuses a rename onto another item's name and leaves the row unchanged", async () => {
    const k = await make("Patch rename source");
    await make("Patch rename target");
    const r = await patch(`/items/${k}`, await hdr("u3"), { n: "patch RENAME target", grp: "Moved" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("patch RENAME target is already in the catalogue");
    // The whole patch is refused, not just the half that clashed.
    expect((await get("/items"))[k]).toMatchObject({ n: "Patch rename source", g: "Other" });
  });

  it("allows a case-only rename of an item's own name", async () => {
    const k = await make("Patch case rename");
    const r = await patch(`/items/${k}`, await hdr("u3"), { n: "PATCH CASE RENAME" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.item.n).toBe("PATCH CASE RENAME");
  });

  it("changes only the field it names - a patch of one does not reset the rest", async () => {
    const k = await make("Patch one field", { unit: "kg", cost: 18, mrp: 25, grp: "Dairy", hsn: "0401", gst: 12, reorder: 7 });
    const before = (await get("/items"))[k];
    const r = await patch(`/items/${k}`, await hdr("u3"), { rl: 9 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.item).toEqual({ ...before, rl: 9 });
  });

  it("retires an item with nothing on the shelf and no menu listing", async () => {
    const k = await make("Patch retire clean");
    const r = await patch(`/items/${k}`, await hdr("u3"), { active: false });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.item.active).toBe(false);
    expect(r.json().message).toBe("Patch retire clean retired - it stays on past documents and cannot be sold or ordered again");
    // Still on the wire: a bill or a ticket raised before today still names it, and the screen
    // showing that document needs the name rather than the raw key.
    expect((await get("/items"))[k]).toMatchObject({ n: "Patch retire clean", active: false });
  });

  it("refuses to retire an item that still has stock, naming where", async () => {
    const k = await make("Patch retire stocked", { opening: 4 });
    const r = await patch(`/items/${k}`, await hdr("u3"), { active: false });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Patch retire stocked still has stock at Central Store - write it off before retiring it");
  });

  it("refuses to retire an item still listed at an outlet, naming the outlets", async () => {
    const k = await make("Patch retire listed");
    for (const list of ["PL-001", "PL-002"]) await put(`/prices/${list}/${k}`, await hdr("u2"), { price: 12 });
    await post("/menus/coffee/items", await hdr("u2"), { it: k });
    await post("/menus/kiosk/items", await hdr("u2"), { it: k });
    const r = await patch(`/items/${k}`, await hdr("u3"), { active: false });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Patch retire listed is still listed at Coffee Shop, Snack Kiosk - take it off those menus before retiring it");
  });

  it("brings a retired item back, and GET /items carries it again", async () => {
    const k = await make("Patch restore");
    expect((await patch(`/items/${k}`, await hdr("u3"), { active: false })).statusCode).toBe(200);
    const r = await patch(`/items/${k}`, await hdr("u2"), { active: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().message).toBe("Patch restore is back in the catalogue");
    expect((await get("/items"))[k].active).toBe(true);
  });

  it("writes a document_history row and announces items", async () => {
    const k = await make("Patch history");
    const r = await patch(`/items/${k}`, await hdr("u3"), { hsn: "2202" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().changed).toEqual(["items"]);
    const rows = await app.testDb!.db.select().from(documentHistory)
      .where(and(eq(documentHistory.docType, "item"), eq(documentHistory.docId, k)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "Updated", who: "u3" });
  });

  it("one of two concurrent renames onto the same name lands", async () => {
    // Each patch locks its own row, so the two never wait on each other's document lock: the
    // arbiter is `items_name_ci_uq` on the UPDATE itself, and the loser reads the pre-check's
    // own sentence. Without `warmPool` the two run back to back on one connection and this
    // would pass with the index removed.
    await warmPool(app.testDb!, 2);
    const a = await make("Patch race A");
    const b = await make("Patch race B");
    const both = await Promise.all([
      patch(`/items/${a}`, await hdr("u3"), { n: "Patch race winner" }),
      patch(`/items/${b}`, await hdr("u3"), { n: "Patch race winner" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    expect(both.find((r) => r.statusCode === 422)!.json().error.message).toBe("Patch race winner is already in the catalogue");
  });
});
