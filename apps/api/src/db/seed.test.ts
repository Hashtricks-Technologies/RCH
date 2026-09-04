import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as FX from "@rch/contract/fixtures";
import { withTestSchema, type TestDb } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { seedDatabase, grnPoLineNo } from "./seed.js";
import { rebuildBalances } from "../lib/ledger.js";
import { bills, grns, items, locations, payers, purchaseOrders, rateContracts, reservations, sequences, shopAsks, stockBalances, stockRequests, supportTickets, tickets, users } from "./schema/index.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("seed"); await seedTestDb(t.db); });
afterAll(async () => { await t.close(); });

const count = async (tbl: PgTable) => Number(((await t.db.execute(sql`select count(*)::int as n from ${tbl}`)).rows[0] as { n: number }).n);

describe("seed", () => {
  it("loads every master table", async () => {
    expect(await count(locations)).toBe(Object.keys(FX.LOC).length + 1); // + quarantine
    expect(await count(items)).toBe(Object.keys(FX.IT).length);
    expect(await count(users)).toBe(FX.USERS.length);
    // The three rosters a non-cash bill may be posted to, in one table. A patient the counter
    // can pick but the server cannot find is a bill it would refuse, so the lists have to match.
    expect(await count(payers)).toBe(FX.PATIENTS.length + FX.STAFF.length + FX.DEPTS.length);
    const staff = await t.db.select().from(payers).where(eq(payers.id, "RC-1902"));
    expect(staff.map((p) => [p.kind, p.name, p.active])).toEqual([["staff", "Vinoth Prakash · Kitchen", true]]);
  });
  it("opening stock equals the fixture at every location and the cache matches the moves", async () => {
    for (const [loc, byItem] of Object.entries(FX.seedStock)) for (const [it, q] of Object.entries(byItem)) {
      const r = await t.db.select().from(stockBalances).where(sql`loc = ${loc} and item_key = ${it}`);
      expect(r[0]?.onHand ?? 0, `${loc}/${it}`).toBe(q);
    }
    const before = await t.db.select().from(stockBalances);
    await rebuildBalances(t.db);
    const after = await t.db.select().from(stockBalances);
    const norm = (rows: typeof before) => rows.filter((r) => r.onHand !== 0).map((r) => [r.loc, r.itemKey, r.onHand]).sort();
    expect(norm(after)).toEqual(norm(before));
  });
  it("loads the open documents and reserves stock for issued tickets", async () => {
    expect(await count(stockRequests)).toBe(FX.seedReq.length);
    expect(await count(tickets)).toBe(FX.seedTkt.length);
    const issued = FX.seedTkt.filter((x) => x.st === "Issued").flatMap((x) => x.lines).length;
    expect(await count(reservations)).toBe(issued);
    expect(await count(bills)).toBe(FX.seedBills.length);
    expect(await count(purchaseOrders)).toBe(FX.seedPo.length);
    expect(await count(grns)).toBe(FX.seedGrn.length);
    expect(await count(supportTickets)).toBe(FX.seedTickets().length);
    expect(await count(rateContracts)).toBe(FX.seedContracts().length);
    expect(await count(shopAsks)).toBe(FX.seedShopAsks().length);
  });
  it("sequences continue the visible series", async () => {
    const r = await t.db.select().from(sequences).where(eq(sequences.kind, "req"));
    expect(r[0].next).toBe(913);
  });
  it("refuses to run twice without --force", async () => {
    await expect(seedDatabase(t.db, { password: "changeme", forcePasswordChange: false })).rejects.toThrow(/already/);
  });
});

describe("grnPoLineNo", () => {
  const po = { lines: [{ it: "milk" }, { it: "sugar" }] };
  it("resolves the ordered line's index", () => {
    expect(grnPoLineNo(po, { id: "G1", po: "PO-1", it: "sugar" })).toBe(1);
  });
  it("throws a clear error instead of defaulting to line 0 when the item was never ordered", () => {
    expect(() => grnPoLineNo(po, { id: "G1", po: "PO-1", it: "flour" })).toThrow("GRN G1: flour is not on PO-1");
  });
  it("throws when the PO itself is missing", () => {
    expect(() => grnPoLineNo(undefined, { id: "G1", po: "PO-404", it: "milk" })).toThrow("GRN G1: milk is not on PO-404");
  });
});
