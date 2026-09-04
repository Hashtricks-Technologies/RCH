import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestSchema, truncateAll, warmPool, type TestDb } from "../test/db.js";
import { seedDatabase } from "../db/seed.js";
import { reserve, releaseForTicket, reservedAt } from "./reservations.js";
import { lockBalances } from "./ledger.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("reservations"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await truncateAll(t.db); await seedDatabase(t.db, { password: "changeme", forcePasswordChange: false, force: true }); });

describe("reservations", () => {
  it("holds stock at a location without moving it", async () => {
    await t.db.transaction(async (tx) => {
      await lockBalances(tx, [{ loc: "store", it: "milk" }]);
      await reserve(tx, [{ loc: "store", it: "milk", qty: 4, ticketId: "TKT-0999" }]);
    });
    const open = await t.db.transaction((tx) => reservedAt(tx, "store"));
    expect(open["store:milk"]).toBe(4);
  });

  it("releases only the named ticket's rows, and only once", async () => {
    await t.db.transaction(async (tx) => {
      await reserve(tx, [{ loc: "store", it: "milk", qty: 4, ticketId: "TKT-0998" }, { loc: "store", it: "sugar", qty: 2, ticketId: "TKT-0997" }]);
    });
    const first = await t.db.transaction((tx) => releaseForTicket(tx, "TKT-0998"));
    expect(first).toBe(1);
    const again = await t.db.transaction((tx) => releaseForTicket(tx, "TKT-0998"));
    expect(again).toBe(0);
    const open = await t.db.transaction((tx) => reservedAt(tx, "store"));
    expect(open["store:milk"]).toBeUndefined();
    expect(open["store:sugar"]).toBe(2);
  });

  it("reads only the items asked for when a list is given", async () => {
    await t.db.transaction((tx) => reserve(tx, [{ loc: "store", it: "milk", qty: 4, ticketId: "TKT-0996" }, { loc: "store", it: "cup", qty: 100, ticketId: "TKT-0996" }]));
    const open = await t.db.transaction((tx) => reservedAt(tx, "store", ["milk"]));
    expect(open).toEqual({ "store:milk": 4 });
  });

  it("serialises two writers through the balance lock so the same stock is not promised twice", async () => {
    // Both read 12 L on hand. Whichever takes the lock first reserves; the second sees the first.
    // Two clients first, or the pool runs them one after the other and this proves nothing.
    await warmPool(t);
    const attempt = (ticketId: string, want: number) => t.db.transaction(async (tx) => {
      await lockBalances(tx, [{ loc: "store", it: "milk" }]);
      const open = await reservedAt(tx, "store", ["milk"]);
      const free = 12 - (open["store:milk"] ?? 0);
      if (free < want) return "refused";
      await reserve(tx, [{ loc: "store", it: "milk", qty: want, ticketId }]);
      return "reserved";
    });
    const out = await Promise.all([attempt("TKT-0991", 12), attempt("TKT-0992", 12)]);
    expect(out.filter((x) => x === "reserved")).toHaveLength(1);
    expect(out.filter((x) => x === "refused")).toHaveLength(1);
  });
});
