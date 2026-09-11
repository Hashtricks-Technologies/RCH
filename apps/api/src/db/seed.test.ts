import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as FX from "@rch/contract/fixtures";
import { resetDocuments, withTestSchema, type TestDb } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { seedDatabase, grnPoLineNo, historyShiftMs } from "./seed.js";
import { readHistory } from "../lib/history.js";
import { rebuildBalances } from "../lib/ledger.js";
import { bills, grns, items, locations, payers, purchaseOrders, rateContracts, reservations, sequences, shopAsks, stockBalances, stockRequests, supportTickets, tickets, users } from "./schema/index.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("seed"); await seedTestDb(t.db); });
afterAll(async () => { await t.close(); });

const count = async (tbl: PgTable) => Number(((await t.db.execute(sql`select count(*)::int as n from ${tbl}`)).rows[0] as { n: number }).n);

describe("seed", () => {
  it("loads every master table", async () => {
    expect(await count(locations)).toBe(Object.keys(FX.LOC).length); // quarantine is one of them
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

// The shift is ONE decision per seed run, not one per row. Deciding row by row rolled an 08:34
// entry back to yesterday while leaving the 08:05 entry that came before it on today, so a
// request's own trail read approved-before-sent and `documents.test.ts` went red between about
// 08:05 and 08:44 IST every morning.
describe("historyShiftMs", () => {
  afterEach(() => { vi.useRealTimers(); });
  const clockAt = (ist: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(ist)); };

  it("rolls every stamp back an IST day when the last fixture time has not come round yet", () => {
    clockAt("2026-09-14T08:20:00+05:30"); // past the first fixture entry (08:05), short of the last (09:26)
    expect(historyShiftMs()).toBe(-24 * 3600_000);
  });
  it("leaves every stamp on today once the last fixture time has passed", () => {
    clockAt("2026-09-14T12:00:00+05:30");
    expect(historyShiftMs()).toBe(0);
  });
});

describe("seeded history trails", () => {
  const istDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  // Put the clock back and re-seed for real afterwards, so neither case leaves yesterday's
  // stamps behind for anything else reading this file's schema.
  afterEach(async () => { vi.useRealTimers(); await resetDocuments(t.db); });
  const seedAt = async (ist: string) => {
    vi.useFakeTimers({ toFake: ["Date"] }); // Date only — pg's own timers have to keep running
    vi.setSystemTime(new Date(ist));
    await resetDocuments(t.db);
    return readHistory(t.db, "request", "REQ-2026-0909");
  };

  it("reads in fixture order and on a single day when seeded at 08:20 IST", async () => {
    const trail = await seedAt("2026-09-14T08:20:00+05:30");
    expect(trail.map((h) => h.s)).toEqual(["Request sent", "Manager approved", "Ticket issued"]);
    const stamps = trail.map((h) => new Date(h.t).getTime());
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    expect([...new Set(trail.map((h) => istDay.format(new Date(h.t))))]).toEqual(["2026-09-13"]);
  });
  it("stays on today's IST day when seeded at 12:00 IST, past every fixture time", async () => {
    const trail = await seedAt("2026-09-14T12:00:00+05:30");
    expect([...new Set(trail.map((h) => istDay.format(new Date(h.t))))]).toEqual(["2026-09-14"]);
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
