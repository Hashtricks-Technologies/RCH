import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
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
    expect(noTimes(await D.readTickets(t.db))).toEqual(noTimes(FX.seedTkt));
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
    // A doctored name proves the readers below actually use the map they were handed rather
    // than fetching their own copy: if they re-queried, this override would never show up.
    const [anyId, real] = [...names.entries()][0]!;
    const doctored = new Map(names);
    doctored.set(anyId, { ...real, name: "Overridden Name" });
    const [req, prq, grn, pord, bills, sup, prod, asks] = await Promise.all([
      D.readRequests(t.db, doctored), D.readRequisitions(t.db, doctored), D.readGrns(t.db, doctored), D.readProdOrders(t.db, doctored),
      D.readBills(t.db, 7, doctored), D.readSupportTickets(t.db, doctored), D.readProductRequests(t.db, doctored), D.readShopAsks(t.db, doctored),
    ]);
    const usesOverride = req.some((r) => r.by === "Overridden Name") || prq.some((p) => p.by === "Overridden Name")
      || grn.some((g) => g.by === "Overridden Name") || pord.some((o) => o.by === "Overridden Name")
      || bills.some((b) => b.opr === "Overridden Name") || sup.some((t2) => t2.by === "Overridden Name")
      || prod.some((p) => p.by === "Overridden Name") || asks.some((a) => a.by === "Overridden Name");
    expect(usesOverride).toBe(true);
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
