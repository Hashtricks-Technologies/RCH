import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestSchema, truncateAll, warmPool, type TestDb } from "../test/db.js";
import { lockBalances, postMoves, rebuildBalances } from "./ledger.js";
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
    { key: "kitchen", name: "Central Kitchen", code: "KT-CK", type: "Kitchen", floor: "G", costCentre: "CC" },
  ]);
  await t.db.insert(items).values({ key: "milk", code: "RM-1001", name: "Milk 1L", unit: "L", type: "RAW", grp: "Dairy", hsn: "0401", gst: 0 });
  await t.db.insert(items).values({ key: "sugar", code: "RM-1002", name: "Sugar 1kg", unit: "kg", type: "RAW", grp: "Dry", hsn: "1701", gst: 0 });
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
  it("keeps a key that contains a space apart from its neighbours", async () => {
    // A new product's key is whatever the central store types. The batch is keyed by
    // (loc, item) internally; nothing may re-derive the pair by splitting the key back apart.
    await t.db.insert(items).values({ key: "milk 2", code: "RM-1010", name: "Milk 2L", unit: "L", type: "RAW", grp: "Dairy", hsn: "0401", gst: 0 });
    await withTransaction(t.db, (tx) => postMoves(tx, [
      { loc: "store", it: "milk", qty: 4, kind: "opening", refType: "seed", refId: "o" },
      { loc: "store", it: "milk 2", qty: 6, kind: "opening", refType: "seed", refId: "o" },
    ]));
    expect(await onHand("store", "milk")).toBe(4);
    expect(await onHand("store", "milk 2")).toBe(6);
  });
  it("survives 20 writers, four at a time (the test pool), touching the same pair of balances in alternating lock orders without deadlocking", async () => {
    // postMoves sorts the (loc, item) keys it locks into a fixed order, so writers that submit
    // the pair in opposite orders still take their row locks in the same sequence — no deadlock.
    const writers = Array.from({ length: 20 }, (_, i) =>
      withTransaction(t.db, (tx) => postMoves(tx, i % 2 === 0
        ? [
            { loc: "store", it: "milk", qty: 1, kind: "opening", refType: "seed", refId: "c" },
            { loc: "store", it: "sugar", qty: 2, kind: "opening", refType: "seed", refId: "c" },
          ]
        : [
            { loc: "store", it: "sugar", qty: 2, kind: "opening", refType: "seed", refId: "c" },
            { loc: "store", it: "milk", qty: 1, kind: "opening", refType: "seed", refId: "c" },
          ])));
    await expect(Promise.all(writers)).resolves.toBeDefined();
    expect(await onHand("store", "milk")).toBe(20);
    expect(await onHand("store", "sugar")).toBe(40);
  });
  it("rebuildBalances reproduces the cache from the moves", async () => {
    await withTransaction(t.db, (tx) => postMoves(tx, [{ loc: "store", it: "milk", qty: 7, kind: "opening", refType: "seed", refId: "o" }]));
    await t.db.update(stockBalances).set({ onHand: 999 });
    const r = await rebuildBalances(t.db);
    expect(r.rows).toBe(1);
    expect(await onHand("store", "milk")).toBe(7);
  });
  it("rebuildBalances keeps a carried-but-dry row instead of dropping the line off the shelf", async () => {
    // A balance row with no moves behind it is how the seed says "this location stocks sugar,
    // and today it has none" — the stock screens show a dash for a line with no row at all and
    // a 0 for a dry one (M12). A rebuild that deleted first would quietly turn one into the
    // other, so the row has to survive at zero.
    await t.db.insert(stockBalances).values({ loc: "coffee", itemKey: "sugar", onHand: 0 });
    await withTransaction(t.db, (tx) => postMoves(tx, [{ loc: "store", it: "milk", qty: 7, kind: "opening", refType: "seed", refId: "o" }]));
    await rebuildBalances(t.db);
    expect(await onHand("store", "milk")).toBe(7);
    const dry = await t.db.select().from(stockBalances).where(and(eq(stockBalances.loc, "coffee"), eq(stockBalances.itemKey, "sugar")));
    expect(dry.length).toBe(1);
    expect(dry[0].onHand).toBe(0);
  });
});

describe("lockBalances", () => {
  it("locks a pair the same way whoever asks, and folds a repeat into one lock", async () => {
    // Two writers taking the same two cells in opposite input order must not deadlock: both
    // visit (kitchen, milk) before (store, milk) because lockBalances sorts, not its caller.
    // Two clients first, or the pool runs them one after the other and nothing is raced.
    await warmPool(t);
    const both = await Promise.allSettled([
      t.db.transaction(async (tx) => { await lockBalances(tx, [{ loc: "store", it: "milk" }, { loc: "kitchen", it: "milk" }, { loc: "store", it: "milk" }]); }),
      t.db.transaction(async (tx) => { await lockBalances(tx, [{ loc: "kitchen", it: "milk" }, { loc: "store", it: "milk" }]); }),
    ]);
    expect(both.every((r) => r.status === "fulfilled")).toBe(true);
  });
});
