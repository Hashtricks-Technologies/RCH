import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestSchema, truncateAll, warmPool, type TestDb } from "../test/db.js";
import { seedDatabase } from "../db/seed.js";
import { given } from "../test/builders.js";
import { reserve, releaseForTicket, reservedAt } from "./reservations.js";
import { lockBalances } from "./ledger.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("reservations"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await truncateAll(t.db); await seedDatabase(t.db, { password: "changeme", forcePasswordChange: false, force: true }); });

/**
 * A hold needs a ticket to hang on: migration 0008 gave `reservations.ticket_id` the foreign key
 * the Drizzle schema could not declare (`tickets` lives in another module and the import would
 * close a cycle). That is how the server has always worked — `writeTicket` inserts the ticket row
 * and reserves against it in one transaction — so these cases say it out loud rather than holding
 * stock for a ticket number nobody ever issued. `reserve: false` keeps the builder's own hold out
 * of the way: what is under test is the hold this file places.
 */
const ticketFor = (lines: { it: string; qty: number }[]): Promise<string> =>
  given.ticket(t.db, { from: "store", to: "coffee", lines, reserve: false });

describe("reservations", () => {
  it("holds stock at a location without moving it", async () => {
    const tkt = await ticketFor([{ it: "milk", qty: 4 }]);
    await t.db.transaction(async (tx) => {
      await lockBalances(tx, [{ loc: "store", it: "milk" }]);
      await reserve(tx, [{ loc: "store", it: "milk", qty: 4, ticketId: tkt }]);
    });
    const open = await t.db.transaction((tx) => reservedAt(tx, "store"));
    expect(open["store:milk"]).toBe(4);
  });

  it("releases only the named ticket's rows, and only once", async () => {
    const mine = await ticketFor([{ it: "milk", qty: 4 }]);
    const other = await ticketFor([{ it: "sugar", qty: 2 }]);
    await t.db.transaction(async (tx) => {
      await reserve(tx, [{ loc: "store", it: "milk", qty: 4, ticketId: mine }, { loc: "store", it: "sugar", qty: 2, ticketId: other }]);
    });
    const first = await t.db.transaction((tx) => releaseForTicket(tx, mine));
    expect(first).toBe(1);
    const again = await t.db.transaction((tx) => releaseForTicket(tx, mine));
    expect(again).toBe(0);
    const open = await t.db.transaction((tx) => reservedAt(tx, "store"));
    expect(open["store:milk"]).toBeUndefined();
    expect(open["store:sugar"]).toBe(2);
  });

  it("reads only the items asked for when a list is given", async () => {
    const tkt = await ticketFor([{ it: "milk", qty: 4 }, { it: "cup", qty: 100 }]);
    await t.db.transaction((tx) => reserve(tx, [{ loc: "store", it: "milk", qty: 4, ticketId: tkt }, { loc: "store", it: "cup", qty: 100, ticketId: tkt }]));
    const open = await t.db.transaction((tx) => reservedAt(tx, "store", ["milk"]));
    expect(open).toEqual({ "store:milk": 4 });
  });

  it("serialises two writers through the balance lock so the same stock is not promised twice", async () => {
    // Both read 12 L on hand. Whichever takes the lock first reserves; the second sees the first.
    // Two clients first, or the pool runs them one after the other and this proves nothing.
    const [one, two] = [await ticketFor([{ it: "milk", qty: 12 }]), await ticketFor([{ it: "milk", qty: 12 }])];
    await warmPool(t);
    const attempt = (ticketId: string, want: number) => t.db.transaction(async (tx) => {
      await lockBalances(tx, [{ loc: "store", it: "milk" }]);
      const open = await reservedAt(tx, "store", ["milk"]);
      const free = 12 - (open["store:milk"] ?? 0);
      if (free < want) return "refused";
      await reserve(tx, [{ loc: "store", it: "milk", qty: want, ticketId }]);
      return "reserved";
    });
    const out = await Promise.all([attempt(one, 12), attempt(two, 12)]);
    expect(out.filter((x) => x === "reserved")).toHaveLength(1);
    expect(out.filter((x) => x === "refused")).toHaveLength(1);
  });
});
