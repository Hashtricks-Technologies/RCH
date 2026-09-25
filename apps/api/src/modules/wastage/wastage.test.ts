import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { resetDocuments, truncateAll } from "../../test/db.js";
import { documentHistory, stockBalances, stockMoves, wastage } from "../../db/schema/index.js";
import { withTransaction } from "../../lib/db.js";
import { postMoves } from "../../lib/ledger.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => {
  app = await buildTestApp({ schema: "wastage" });
  await app.ready();
  await truncateAll(app.testDb!.db);
  await seedTestDb(app.testDb!.db);
});
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDocuments(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: await hdr(user), ...(payload ? { payload } : {}) });
const get = async (user: string, url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: await authHeaders(app, user) });
const balance = async (loc: string, it: string): Promise<number | undefined> => {
  const [row] = await app.testDb!.db.select().from(stockBalances).where(and(eq(stockBalances.loc, loc), eq(stockBalances.itemKey, it)));
  return row?.onHand;
};
const moves = async (refType: string, refId: string) =>
  (await app.testDb!.db.select().from(stockMoves).where(and(eq(stockMoves.refType, refType), eq(stockMoves.refId, refId))))
    .map((m) => ({ loc: m.loc, it: m.itemKey, qty: m.qty, kind: m.kind }));

describe("raw materials and packaging are used as they land at the kitchen", () => {
  it("a ticket received at the kitchen posts the landing and its use, and leaves the kitchen holding nothing", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "kitchen", lines: [{ it: "maida", qty: 5 }, { it: "box", qty: 50 }], st: "Collected" });
    const r = await post("u4", `/tickets/${id}/receive`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().message).toBe("Received at Central Kitchen - issued to the kitchen for use");
    expect(await moves("ticket", id)).toEqual(expect.arrayContaining([
      { loc: "kitchen", it: "maida", qty: 5, kind: "ticket_in" },
      { loc: "kitchen", it: "maida", qty: -5, kind: "production_consume" },
      { loc: "kitchen", it: "box", qty: 50, kind: "ticket_in" },
      { loc: "kitchen", it: "box", qty: -50, kind: "production_consume" },
    ]));
    expect(await balance("kitchen", "maida")).toBe(0);
    expect(await balance("kitchen", "box")).toBe(0);
  });

  it("a raw line received at an outlet stays on its shelf", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }], st: "Collected" });
    const before = await balance("coffee", "milk");
    const r = await post("u1", `/tickets/${id}/receive`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().message).toBe("Received at Coffee Shop - stock is on the shelf");
    expect(await moves("ticket", id)).toEqual([{ loc: "coffee", it: "milk", qty: 2, kind: "ticket_in" }]);
    expect(await balance("coffee", "milk")).toBe((before ?? 0) + 2);
  });

  it("the stock read never shows the kitchen a raw or packing line, even the row a landing leaves at zero", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "kitchen", lines: [{ it: "sugar", qty: 3 }], st: "Collected" });
    await post("u4", `/tickets/${id}/receive`);
    expect(await balance("kitchen", "sugar")).toBe(0);
    for (const user of ["u4", "u3", "u2"]) {
      const kitchen = (await get(user, "/stock")).json().stock.kitchen as Record<string, number>;
      expect(Object.keys(kitchen).sort(), user).toEqual(["puff", "salad", "sand"]);
    }
  });

  it("a kitchen count-up of a raw line lands and is used; a write-off of one is refused towards wastage", async () => {
    const up = await post("u4", "/adjustments", { loc: "kitchen", reason: "count", lines: [{ it: "oil", qty: 2 }] });
    expect(up.statusCode, up.body).toBe(200);
    expect(await moves("adjustment", up.json().result.id)).toEqual(expect.arrayContaining([
      { loc: "kitchen", it: "oil", qty: 2, kind: "adjustment" },
      { loc: "kitchen", it: "oil", qty: -2, kind: "production_consume" },
    ]));
    expect(await balance("kitchen", "oil")).toBe(0);

    const down = await post("u4", "/adjustments", { loc: "kitchen", reason: "wastage", lines: [{ it: "oil", qty: -1 }] });
    expect(down.statusCode).toBe(422);
    expect(down.json().error.message).toBe("Refined sunflower oil is not stocked at the kitchen - it was used when it arrived; record it as wastage instead");
    // A counted finished good on the rack is still written off the ordinary way.
    const fg = await post("u4", "/adjustments", { loc: "kitchen", reason: "wastage", lines: [{ it: "puff", qty: -2 }] });
    expect(fg.statusCode, fg.body).toBe(200);
    expect(await balance("kitchen", "puff")).toBe(22);
  });

  it("a raw line the kitchen adds with an opening figure is issued for use, not shelved", async () => {
    const r = await post("u4", "/items", { name: "Rice flour", unit: "kg", type: "RAW", cost: 60, loc: "kitchen", opening: 4 });
    expect(r.statusCode, r.body).toBe(200);
    const key = r.json().result.key as string;
    expect(r.json().message).toBe(`Rice flour added to the catalogue as ${r.json().result.item.c} with 4.000 kg issued to Central Kitchen for use`);
    expect(await moves("item", key)).toEqual(expect.arrayContaining([
      { loc: "kitchen", it: key, qty: 4, kind: "opening" },
      { loc: "kitchen", it: key, qty: -4, kind: "production_consume" },
    ]));
    expect(await balance("kitchen", key)).toBe(0);
  });
});

describe("POST /wastage", () => {
  it("records a loss at cost, touches no stock, and is never refused for more than is free", async () => {
    const before = await app.testDb!.db.select({ n: sql<number>`count(*)::int` }).from(stockMoves);
    const r = await post("u4", "/wastage", { it: "maida", qty: 2.5, reason: "expired", note: "Weevils in the sack" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ it: "maida", qty: 2.5, reason: "expired", note: "Weevils in the sack", cost: 42, value: 105, by: "Vinoth Prakash" });
    expect(b.result.id).toMatch(/^WST-\d{4}-\d{4}$/);
    expect(b.changed).toEqual(["wastage"]);
    expect(b.message).toBe(`${b.result.id} - 2.500 kg of Maida recorded as wasted (expired), ₹105.00 at cost`);
    const after = await app.testDb!.db.select({ n: sql<number>`count(*)::int` }).from(stockMoves);
    expect(after[0]!.n).toBe(before[0]!.n);
    const [row] = await app.testDb!.db.select().from(wastage).where(eq(wastage.id, b.result.id));
    expect(row).toMatchObject({ itemKey: "maida", qty: 2.5, cost: 42, value: 105, byUser: "u4" });
    const trail = await app.testDb!.db.select().from(documentHistory).where(eq(documentHistory.docId, b.result.id));
    expect(trail.map((h) => h.status)).toEqual(["Expired"]);
  });

  it("steps the WST series by one", async () => {
    const a = (await post("u4", "/wastage", { it: "cup", qty: 10, reason: "breakage" })).json().result.id as string;
    const b = (await post("u4", "/wastage", { it: "cup", qty: 5, reason: "wastage" })).json().result.id as string;
    expect(Number(b.slice(-4))).toBe(Number(a.slice(-4)) + 1);
  });

  it("refuses what is not a kitchen raw or packing line, a zero, and Other with nothing said", async () => {
    const fg = await post("u4", "/wastage", { it: "puff", qty: 2, reason: "wastage" });
    expect(fg.statusCode).toBe(422);
    expect(fg.json().error.message).toBe("Veg puffs is counted on the kitchen's rack - write it off from Kitchen Stock instead");
    const mrp = await post("u4", "/wastage", { it: "juice", qty: 2, reason: "wastage" });
    expect(mrp.json().error.message).toBe("Real Juice 200ml is not a raw material or packing line the kitchen uses - wastage is recorded for those alone");
    const zero = await post("u4", "/wastage", { it: "milk", qty: 0, reason: "wastage" });
    expect(zero.json().error.message).toBe("Enter a quantity");
    const other = await post("u4", "/wastage", { it: "milk", qty: 1, reason: "other", note: "  " });
    expect(other.json().error.message).toBe("Say what happened when the reason is Other");
    const gone = await post("u4", "/wastage", { it: "nothing", qty: 1, reason: "wastage" });
    expect(gone.statusCode).toBe(404);
    const count = await post("u4", "/wastage", { it: "milk", qty: 1, reason: "count" });
    expect(count.statusCode).toBe(400);
  });

  it("is the kitchen's alone: the store keeper is held to the kitchen, a counter is not let in", async () => {
    const store = await post("u3", "/wastage", { it: "milk", qty: 1, reason: "wastage" });
    expect(store.statusCode).toBe(403);
    expect(store.json().error.message).toBe("You can only do this for the Central Kitchen.");
    expect((await post("u1", "/wastage", { it: "milk", qty: 1, reason: "wastage" })).statusCode).toBe(404);
  });
});

describe("GET /reports/kitchen", () => {
  it("reports what was issued to the kitchen at cost, and the wastage, over the window", async () => {
    const t = await given.ticket(app.testDb!.db, { from: "store", to: "kitchen", lines: [{ it: "maida", qty: 5 }, { it: "cup", qty: 100 }], st: "Collected" });
    await post("u4", `/tickets/${t}/receive`);
    await post("u4", "/adjustments", { loc: "kitchen", reason: "count", lines: [{ it: "maida", qty: 1 }] });
    const w = (await post("u4", "/wastage", { it: "maida", qty: 1, reason: "wastage", note: "Spilled" })).json().result.id;

    const r = await get("u4", "/reports/kitchen?days=7");
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.issued).toEqual([{ it: "cup", qty: 100, value: 62 }, { it: "maida", qty: 6, value: 252 }]);
    expect(b.wastage.map((x: { id: string }) => x.id)).toEqual([w]);
    expect(Date.parse(b.to) - Date.parse(b.from)).toBe(7 * 86_400_000);
  });

  it("defaults to today, and is the kitchen's report", async () => {
    const r = await get("u4", "/reports/kitchen");
    expect(r.statusCode).toBe(200);
    expect(Date.parse(r.json().to) - Date.parse(r.json().from)).toBe(86_400_000);
    expect((await get("u3", "/reports/kitchen")).statusCode).toBe(404);
  });
});

describe("migration 0028's clearing step", () => {
  it("clears what the kitchen held of each raw and packing line as used, and leaves everything else alone", async () => {
    const db = app.testDb!.db;
    // A kitchen holding raw stock the way the demo hospital used to - booked straight onto the
    // shelf, as no write can any more.
    await withTransaction(db, (tx) => postMoves(tx, [
      { loc: "kitchen", it: "maida", qty: 8, kind: "opening", refType: "test", refId: "old" },
      { loc: "kitchen", it: "cup", qty: 200, kind: "opening", refType: "test", refId: "old" },
    ]));
    const file = readFileSync(fileURLToPath(new URL("../../../drizzle/0028_kitchen_wastage.sql", import.meta.url)), "utf8");
    const step = file.slice(file.indexOf("INSERT INTO \"stock_moves\"")).split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
    expect(step).toHaveLength(2);
    for (const stmt of step) await db.execute(sql.raw(stmt));

    expect(await balance("kitchen", "maida")).toBe(0);
    expect(await balance("kitchen", "cup")).toBe(0);
    expect(await balance("kitchen", "puff")).toBe(24);
    expect(await moves("migration", "0028_kitchen_wastage")).toEqual(expect.arrayContaining([
      { loc: "kitchen", it: "maida", qty: -8, kind: "production_consume" },
      { loc: "kitchen", it: "cup", qty: -200, kind: "production_consume" },
    ]));
    // A second pass finds nothing left to clear.
    for (const stmt of step) await db.execute(sql.raw(stmt));
    expect(await moves("migration", "0028_kitchen_wastage")).toHaveLength(2);
  });
});
