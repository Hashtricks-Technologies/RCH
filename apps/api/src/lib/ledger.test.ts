import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestSchema, truncateAll, type TestDb } from "../test/db.js";
import { postMoves, rebuildBalances } from "./ledger.js";
import { withTransaction } from "./db.js";
import { items, locations, stockBalances, stockMoves } from "../db/schema/index.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("ledger"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await truncateAll(t.db);
  await t.db.insert(locations).values([
    { key: "store", name: "Central Store", code: "WH-CS", type: "Store", floor: "B", costCentre: "CC" },
    { key: "coffee", name: "Coffee Shop", code: "OT-C3", type: "Outlet", floor: "3", costCentre: "CC", priceList: "B", sellable: true },
  ]);
  await t.db.insert(items).values({ key: "milk", code: "RM-1001", name: "Milk 1L", unit: "L", type: "RAW", grp: "Dairy", hsn: "0401", gst: 0 });
});

const onHand = async (loc: string, it: string) =>
  (await t.db.select().from(stockBalances).where(and(eq(stockBalances.loc, loc), eq(stockBalances.itemKey, it))))[0]?.onHand ?? 0;

describe("postMoves", () => {
  it("appends moves and keeps the balance cache in step", async () => {
    await withTransaction(t.db, (tx) => postMoves(tx, [
      { loc: "store", it: "milk", qty: 12, kind: "opening", refType: "seed", refId: "opening" },
      { loc: "store", it: "milk", qty: -2.5, kind: "ticket_out", refType: "ticket", refId: "TKT-0440" },
      { loc: "coffee", it: "milk", qty: 2.5, kind: "ticket_in", refType: "ticket", refId: "TKT-0440" },
    ]));
    expect(await onHand("store", "milk")).toBe(9.5);
    expect(await onHand("coffee", "milk")).toBe(2.5);
    expect((await t.db.select().from(stockMoves)).length).toBe(3);
  });
  it("rounds to three decimals", async () => {
    await withTransaction(t.db, (tx) => postMoves(tx, [
      { loc: "store", it: "milk", qty: 0.1, kind: "opening", refType: "seed", refId: "o" },
      { loc: "store", it: "milk", qty: 0.2, kind: "opening", refType: "seed", refId: "o" },
    ]));
    expect(await onHand("store", "milk")).toBe(0.3);
  });
  it("is atomic: a failing move leaves nothing behind", async () => {
    await expect(withTransaction(t.db, (tx) => postMoves(tx, [
      { loc: "store", it: "milk", qty: 1, kind: "opening", refType: "seed", refId: "o" },
      { loc: "nowhere", it: "milk", qty: 1, kind: "opening", refType: "seed", refId: "o" },
    ]))).rejects.toThrow();
    expect((await t.db.select().from(stockMoves)).length).toBe(0);
    expect(await onHand("store", "milk")).toBe(0);
  });
  it("survives 25 concurrent writers to the same balance without losing an update", async () => {
    await Promise.all(Array.from({ length: 25 }, () =>
      withTransaction(t.db, (tx) => postMoves(tx, [{ loc: "store", it: "milk", qty: 1, kind: "opening", refType: "seed", refId: "c" }]))));
    expect(await onHand("store", "milk")).toBe(25);
  });
  it("rebuildBalances reproduces the cache from the moves", async () => {
    await withTransaction(t.db, (tx) => postMoves(tx, [{ loc: "store", it: "milk", qty: 7, kind: "opening", refType: "seed", refId: "o" }]));
    await t.db.update(stockBalances).set({ onHand: 999 });
    const r = await rebuildBalances(t.db);
    expect(r.rows).toBe(1);
    expect(await onHand("store", "milk")).toBe(7);
  });
});
