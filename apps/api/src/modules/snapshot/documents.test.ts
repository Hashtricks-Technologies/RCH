import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import { eq } from "drizzle-orm";
import * as s from "../../db/schema/index.js";
import { withTestSchema, type TestDb } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import * as D from "./readers/documents.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("documents"); await seedTestDb(t.db); });
afterAll(async () => { await t.close(); });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Fixtures hold "HH:MM"; the wire holds ISO. Compare everything except the time fields, then check those are ISO. */
const strip = <T extends Record<string, unknown>>(o: T, keys: string[]): Partial<T> => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k))) as Partial<T>;
const noTimes = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (k, v) => (["at", "t", "recv", "bb"].includes(k) ? undefined : v)));
/** The reader orders documents for a sensible feed (most-recent-first, etc.); the fixture
 *  arrays are hand-ordered for a demo narrative and do not always agree. Sort both sides by
 *  id before comparing content so the assertion is about the data, not display order. */
const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.id.localeCompare(b.id));

describe("document readers", () => {
  it("stock requests match the fixtures, with ISO times and history", async () => {
    const got = await D.readRequests(t.db);
    expect(got.map((r) => r.id).sort()).toEqual(FX.seedReq.map((r) => r.id).sort());
    for (const r of got) {
      const fx = FX.seedReq.find((x) => x.id === r.id)!;
      expect(noTimes(strip(r, ["hist"]))).toEqual(noTimes(strip(fx, ["hist"])));
      expect(r.at).toMatch(ISO);
      expect(r.hist.map((h) => h.s)).toEqual(fx.hist.map((h) => h.s));
      for (const h of r.hist) expect(h.t).toMatch(ISO);
    }
  });
  it("tickets, requisitions, purchase orders, GRNs, production, batches", async () => {
    // `readTickets` reads `document_history` now, like every other reader here. `hist` is still
    // stripped from both sides — the same way prq/pord are — because the seeder replays the
    // fixtures' trails for requests, requisitions, purchase orders and production orders but
    // not yet for tickets, so `seedTkt`'s one row has nothing on the database side to match.
    // A ticket the server itself writes carries its trail; `tickets.test.ts` asserts that.
    expect(noTimes((await D.readTickets(t.db)).map((o) => strip(o, ["hist"])))).toEqual(noTimes(FX.seedTkt.map((o) => strip(o, ["hist"]))));
    const prq = await D.readRequisitions(t.db); expect(noTimes(byId(prq).map((p) => strip(p, ["hist"])))).toEqual(noTimes(byId(FX.seedPrq).map((p) => strip(p, ["hist"]))));
    const po = await D.readPurchaseOrders(t.db);
    for (const o of po) { const fx = FX.seedPo.find((x) => x.id === o.id)!; expect(noTimes(strip(o, ["hist", "eta"]))).toEqual(noTimes(strip(fx, ["hist", "eta"]))); expect(o.eta).toMatch(/^\d{4}-\d{2}-\d{2}$|^$/); }
    expect(noTimes(byId(await D.readGrns(t.db)))).toEqual(noTimes(byId(FX.seedGrn)));
    expect(noTimes((await D.readProdOrders(t.db)).map((o) => strip(o, ["hist"])))).toEqual(noTimes(FX.seedPord.map((o) => strip(o, ["hist"]))));
    const b = await D.readBatches(t.db); expect(noTimes(b)).toEqual(noTimes(FX.seedBatch)); expect(b[0].bb).toMatch(ISO);
  });
  it("bills carry the operator's colour and only the last N days", async () => {
    const bills = await D.readBills(t.db, 7);
    expect(noTimes(bills)).toEqual(noTimes(FX.seedBills));
  });
  it("vendors, contracts, support tickets, product requests, shop asks", async () => {
    expect(await D.readVendors(t.db)).toEqual(FX.seedVendors);
    const contracts = await D.readContracts(t.db);
    const fxContracts = FX.seedContracts();
    expect(contracts.map((c) => strip(c, ["from", "to"]))).toEqual(fxContracts.map((c) => strip(c, ["from", "to"])));
    for (const c of contracts) { expect(c.from).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(c.to).toMatch(/^\d{4}-\d{2}-\d{2}$/); }
    const sup = await D.readSupportTickets(t.db);
    expect(noTimes(sup)).toEqual(noTimes(FX.seedTickets()));
    expect(sup[0].messages[0].id).toBe(FX.seedTickets()[0].messages[0].id);
    expect(noTimes(await D.readProductRequests(t.db))).toEqual(noTimes(FX.seedProductRequests()));
    const seededTicketIds = new Set(FX.seedTkt.map((tk) => tk.id));
    const gotAsks = await D.readShopAsks(t.db);
    const fxAsks = FX.seedShopAsks().map((a) => {
      if (seededTicketIds.has(a.ticket ?? "")) return a;
      const { ticket: _ticket, ...rest } = a;
      return rest;
    });
    expect(noTimes(byId(gotAsks))).toEqual(noTimes(byId(fxAsks)));
  });
  it("userNames() is one query for the whole snapshot; readers accept it pre-fetched instead of re-querying", async () => {
    const names = await D.userNames(t.db);
    expect(names.size).toBeGreaterThan(0);
    // Doctor every name: if a reader fetched its own copy instead of using the map it was
    // handed, a real name would surface in its output. Checked per collection — one boolean
    // across all eight would stay green with seven readers reverted.
    const doctored: D.UserNames = new Map([...names].map(([id, v]) => [id, { ...v, name: `~${id}` }]));
    const [req, prq, grn, pord, bills, sup, prod, asks] = await Promise.all([
      D.readRequests(t.db, doctored), D.readRequisitions(t.db, doctored), D.readGrns(t.db, doctored), D.readProdOrders(t.db, doctored),
      D.readBills(t.db, 7, doctored), D.readSupportTickets(t.db, doctored), D.readProductRequests(t.db, doctored), D.readShopAsks(t.db, doctored),
    ]);
    const onlyDoctored = (label: string, authors: Array<string | undefined>) => {
      const named = authors.filter((a): a is string => a != null);
      expect(named.length, `${label}: no authors to check`).toBeGreaterThan(0);
      expect(named.every((a) => a.startsWith("~")), `${label}: ${named.filter((a) => !a.startsWith("~")).join(", ")}`).toBe(true);
    };
    onlyDoctored("requests", req.map((r) => r.by));
    onlyDoctored("requisitions", prq.map((p) => p.by));
    onlyDoctored("grns", grn.map((g) => g.by));
    onlyDoctored("production orders", pord.map((o) => o.by));
    onlyDoctored("bills", bills.map((b) => b.opr));
    onlyDoctored("support tickets", sup.map((t2) => t2.by));
    onlyDoctored("product requests", prod.map((p) => p.by));
    onlyDoctored("shop asks", asks.map((a) => a.by));
  });
  it("reads only the windowed bills' lines — a bill outside the window brings none of its own", async () => {
    // bill_lines is the one table that grows with every sale forever. A month-old bill and its
    // lines must both stay out of a seven-day read, or a busy year of them rides along with a
    // week on screen.
    await t.db.insert(s.bills).values({ no: "CF/0001", loc: "coffee", operatorId: "u1", total: 20, tax: 2.14, at: new Date(Date.now() - 30 * 86400_000), tender: "Cash" });
    await t.db.insert(s.billLines).values({ billNo: "CF/0001", lineNo: 1, itemKey: "juice", qty: 1, rate: 20 });
    try {
      const week = await D.readBills(t.db, 7);
      expect(week.some((b) => b.no === "CF/0001")).toBe(false);
      expect(week.length).toBeGreaterThan(0);
      expect(week.every((b) => b.lines.length > 0)).toBe(true);        // the window's own lines are all there
      const month = await D.readBills(t.db, 90);
      expect(month.find((b) => b.no === "CF/0001")?.lines).toEqual([{ it: "juice", qty: 1, rate: 20 }]);
      // Nothing in the window means no line query at all, which is just as well: an empty
      // `in ()` is not SQL. Every seeded bill is timed today, so a window that only starts
      // tomorrow holds none of them whatever hour the suite runs at.
      expect(await D.readBills(t.db, -1)).toEqual([]);
    } finally {
      await t.db.delete(s.billLines).where(eq(s.billLines.billNo, "CF/0001"));
      await t.db.delete(s.bills).where(eq(s.bills.no, "CF/0001"));
    }
  });
  it("sales are 14 day-rows of 3 outlet columns from bills, with day-of-month labels", async () => {
    const { sales, dayLabels } = await D.readSales(t.db, 14);
    expect(sales.length).toBe(14); expect(dayLabels.length).toBe(14);
    expect(sales.every((row) => row.length === 3)).toBe(true);
    const today = sales[13];
    const fxToday = (loc: string) => FX.seedBills.filter((b) => b.loc === loc).reduce((s, b) => s + b.tot, 0);
    expect(today).toEqual([fxToday("rest"), fxToday("coffee"), fxToday("kiosk")]);
  });
});
