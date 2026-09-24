import { describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import type { Adjustment, AdjustmentRequest, Bill, Permissions, Role, Ticket } from "@rch/contract";
import { DESK_DEFAULTS } from "@rch/domain";
import { noTerms } from "../../lib/terms.js";
import type { Snapshot } from "./service.js";
import { redactOtps, scope, scopeBatches, scopeBuying, scopePayers, scopeStock } from "./scope.js";

/**
 * The cuts, read off permissions, against the cuts as they were when they read the desk alone.
 *
 * `legacy` below is the pre-permissions `scope()` verbatim in substance: `role !== "counter"` for
 * the location cut, the batch log and buying; counter and manager for payers; counter, kitchen and
 * store for the OTP. For every seeded role at every location it could stand at, the new `scope()`
 * must hand back exactly what that did.
 */
type Legacy = { role: Role; loc: string; sub: string };
function legacy(s: Snapshot, who: Legacy, owners: Map<string, string>): Snapshot {
  const payers = who.role === "counter" || who.role === "manager";
  const collects = who.role === "counter" || who.role === "prod" || who.role === "store";
  const base: Snapshot = {
    ...s,
    tickets: s.tickets.filter((t) => owners.get(t.id) === who.sub),
    tkt: s.tkt.map((t) => (t.st === "Issued" && t.to === who.loc && collects ? t : { ...t, otp: "" })),
    bills: payers ? s.bills : s.bills.map((b) => (b.payer || b.customerName || b.customerPhone ? { ...b, payer: undefined, customerName: undefined, customerPhone: undefined } : b)),
    roster: payers ? s.roster : { staff: [], depts: [], doctors: [] },
    terms: payers ? s.terms : noTerms(),
  };
  if (who.role !== "counter") return base;
  const L = who.loc;
  const own = (e: [string, unknown][]) => Object.fromEntries(e.filter(([k]) => k.startsWith(`${L}:`)));
  return {
    ...base,
    stock: { [L]: base.stock[L] ?? {} } as Snapshot["stock"],
    rsv: own(Object.entries(base.rsv)) as Snapshot["rsv"],
    ovr: own(Object.entries(base.ovr)) as Snapshot["ovr"],
    menu: { [L]: base.menu[L] ?? [] },
    req: base.req.filter((r) => r.from === L),
    tkt: base.tkt.filter((t) => t.from === L || t.to === L),
    bills: base.bills.filter((b) => b.loc === L),
    shopAsks: base.shopAsks.filter((a) => a.from === L || a.to === L),
    productReqs: base.productReqs.filter((p) => p.forLoc === L),
    pord: base.pord.filter((o) => o.from === L),
    batch: [],
    sales: base.sales.map((row) => (L in row ? { [L]: row[L] ?? 0 } : {})),
    prq: [], po: [], grn: [], vendors: [], contracts: [],
    adjustments: base.adjustments.filter((a) => a.loc === L),
    adjReq: base.adjReq.filter((r) => r.loc === L),
  };
}

// A hospital's worth of documents at every location, with the fields each cut reads filled in:
// an Issued ticket bound to each end, bills charged to people, support tickets by two owners.
const issued = (id: string, from: string, to: string): Ticket => ({ ...FX.seedTkt[0], id, from, to, st: "Issued", otp: "123456" });
const charged = (b: Bill): Bill => ({ ...b, payer: { kind: "staff", id: "E1", name: "A. Nurse" }, customerName: "Walk-in", customerPhone: "98400 00000" } as Bill);
const full: Snapshot = {
  user: FX.USERS[0], items: FX.IT, locations: FX.LOC, users: FX.USERS, prices: FX.PL, priceLists: FX.PRICE_LISTS, menu: FX.MENU,
  stock: FX.seedStock, rsv: FX.seedRsv(), ovr: { "coffee:milk": "Sold out", "kiosk:puff": "Kitchen short" },
  req: FX.seedReq,
  tkt: [...FX.seedTkt, issued("TKT-A", "store", "kiosk"), issued("TKT-B", "store", "kitchen"), issued("TKT-C", "kitchen", "rest"), issued("TKT-D", "kitchen", "store"), { ...issued("TKT-E", "store", "coffee"), st: "Received" }],
  prq: FX.seedPrq, po: FX.seedPo, grn: FX.seedGrn, pord: FX.seedPord, batch: FX.seedBatch,
  bills: FX.seedBills.map((b, i) => (i % 2 ? charged(b) : b)),
  vendors: FX.seedVendors, contracts: FX.seedContracts(), tickets: FX.seedTickets(), productReqs: FX.seedProductRequests(), shopAsks: FX.seedShopAsks(),
  roster: { staff: FX.STAFF, depts: FX.DEPTS, doctors: FX.DOCTORS },
  terms: { classes: FX.CLASS_TERMS, payers: [] } as unknown as Snapshot["terms"],
  sales: FX.seedSales, dayLabels: FX.DAY_LABELS,
  adjustments: [{ id: "ADJ-1", loc: "coffee" }, { id: "ADJ-2", loc: "store" }, { id: "ADJ-3", loc: "kiosk" }] as Adjustment[],
  adjReq: [{ id: "ADR-1", loc: "coffee" }, { id: "ADR-2", loc: "kiosk" }] as AdjustmentRequest[],
};
const owners = new Map(full.tickets.map((t, i) => [t.id, i % 2 ? "u1" : "u2"]));
const PLACES = ["coffee", "kiosk", "rest", "store", "kitchen"] as const;
const DESKS: Role[] = ["counter", "manager", "store", "prod", "buyer"];
const as = (desk: Role, loc: string, perms: Permissions = DESK_DEFAULTS[desk].perms) => ({ desk, loc, perms, sub: "u1" });

describe("scope() - parity with the desk-only cuts", () => {
  it("the fixture exercises every cut", () => {
    // Guard against a vacuous pass: each cut must have something to remove.
    expect(full.bills.some((b) => b.payer)).toBe(true);
    expect(full.batch.length && full.prq.length && full.po.length && full.grn.length && full.vendors.length && full.contracts.length).toBeTruthy();
    expect(new Set(full.req.map((r) => r.from)).size).toBeGreaterThan(1);
  });
  for (const desk of DESKS) for (const loc of PLACES) {
    it(`the seeded ${desk} role at ${loc} reads exactly what the ${desk} desk did`, () => {
      expect(scope(full, as(desk, loc), owners)).toEqual(legacy(full, { role: desk, loc, sub: "u1" }, owners));
    });
  }
});

describe("scope() - read off permissions", () => {
  const counter = DESK_DEFAULTS.counter.perms;
  const plus = (f: Permissions["f"], a: Permissions["a"] = []): Permissions => ({ f: { ...counter.f, ...f }, a: [...counter.a, ...a] });

  it("a counter role given a hospital-wide feature reads every outlet's documents and stock", () => {
    const s = scope(full, as("counter", "coffee", plus({ approvals: "view" })), owners);
    expect(s.req).toEqual(full.req);
    expect(Object.keys(s.stock)).toEqual(Object.keys(full.stock));
    expect(s.bills.map((b) => b.no)).toEqual(full.bills.map((b) => b.no));
    expect(s.sales).toEqual(full.sales);
    // ...but not the back office's: approvals is no screen about batches or buying.
    expect(s.batch).toEqual([]);
    expect(s.po).toEqual([]);
  });
  it("so does one given every outlet", () => {
    const s = scope(full, as("counter", "coffee", plus({}, ["all_outlets"])), owners);
    expect(s.adjustments).toEqual(full.adjustments);
    expect(s.tkt.map((t) => t.id)).toEqual(full.tkt.map((t) => t.id));
  });
  it("buying comes to a counter role with a purchasing feature or Inventory, batches with Items & stock", () => {
    for (const f of ["requisitions", "vendors", "inventory"] as const) {
      const s = scope(full, as("counter", "coffee", plus({ [f]: "view" })), owners);
      expect(s.prq, f).toEqual(full.prq);
      expect(s.contracts, f).toEqual(full.contracts);
      expect(s.batch, f).toEqual([]);
    }
    const s = scope(full, as("counter", "coffee", plus({ items_stock: "view" })), owners);
    expect(s.batch).toEqual(full.batch);
    expect(s.grn).toEqual([]);
  });
  it("the back-office desks keep the batch log and buying whatever their role holds", () => {
    const bare: Permissions = { f: { store_stock: "view" }, a: [] };
    expect(scopeBatches(full.batch, as("store", "store", bare))).toEqual(full.batch);
    expect(scopeBuying(full.po, as("store", "store", bare))).toEqual(full.po);
  });
  it("names on bills, the roster and the rate card go with Bills or Credit, not with the desk", () => {
    const strip = (b: Bill[]) => b.filter((x) => x.payer || x.customerName).length;
    // A counter role without the till and without credit: names stripped.
    const noTill = scope(full, as("counter", "coffee", { f: { outlet_stock: "edit" }, a: [] }), owners);
    expect(strip(noTill.bills)).toBe(0);
    expect(noTill.roster).toEqual({ staff: [], depts: [], doctors: [] });
    expect(noTill.terms).toEqual(noTerms());
    // A store role given credit reads them.
    const store = as("store", "store", { f: { ...DESK_DEFAULTS.store.perms.f, credit: "view" }, a: [] });
    expect(strip(scopePayers(full.bills, store))).toBeGreaterThan(0);
    expect(scope(full, store, owners).roster).toEqual(full.roster);
    // A manager role holding only Prices does not.
    expect(strip(scopePayers(full.bills, as("manager", "rest", { f: { prices: "edit" }, a: [] })))).toBe(0);
  });
  it("the OTP goes to whoever can work a ticket desk at edit, standing at the ticket's `to`", () => {
    const otp = (who: ReturnType<typeof as>) => redactOtps(full.tkt, who).filter((t) => t.otp).map((t) => t.id);
    expect(otp(as("counter", "coffee"))).toEqual(["TKT-0440"]);
    // The same counter with Pick tickets only at view is not a collector.
    expect(otp(as("counter", "coffee", { f: { ...counter.f, outlet_tickets: "view" }, a: [] }))).toEqual([]);
    // The seeded manager holds no ticket feature, so it reads "" even at its own outlet.
    expect(otp(as("manager", "rest"))).toEqual([]);
    expect(otp(as("prod", "kitchen"))).toEqual(["TKT-B"]);
    expect(otp(as("prod", "kitchen", { f: { kitchen_orders: "edit" }, a: [] }))).toEqual([]);
    expect(otp(as("store", "store"))).toEqual(["TKT-D"]);
    expect(otp(as("store", "store", { f: { issue_desk: "view" }, a: [] }))).toEqual([]);
  });
  it("scopeStock cuts on the same test as scope()", () => {
    const part = { stock: full.stock, rsv: full.rsv, ovr: full.ovr };
    expect(Object.keys(scopeStock(part, as("counter", "kiosk")).stock)).toEqual(["kiosk"]);
    expect(scopeStock(part, as("counter", "kiosk", plus({ prices: "view" })))).toEqual(part);
  });
});
