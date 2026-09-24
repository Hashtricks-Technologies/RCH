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

  const own = scope(full, as("counter", "coffee"), owners);
  it("a counter role given Approvals reads every outlet's documents, and still only its own shelf and till", () => {
    const s = scope(full, as("counter", "coffee", plus({ approvals: "view" })), owners);
    expect(s.req).toEqual(full.req);
    expect(s.adjReq).toEqual(full.adjReq);
    expect(s.shopAsks).toEqual(full.shopAsks);
    expect(s.pord).toEqual(full.pord);
    expect(s.productReqs).toEqual(full.productReqs);
    expect(s.tkt.map((t) => t.id)).toEqual(full.tkt.map((t) => t.id));
    expect(s.stock).toEqual(own.stock);
    expect(s.menu).toEqual(own.menu);
    expect(s.adjustments).toEqual(own.adjustments);
    expect(s.bills).toEqual(own.bills);
    expect(s.sales).toEqual(own.sales);
    // ...and not the back office's: approvals is no screen about batches or buying.
    expect(s.batch).toEqual([]);
    expect(s.po).toEqual([]);
  });
  it("the leak: a counter role given the stock ledger reads every shelf, but still only its own bills", () => {
    const s = scope(full, as("counter", "coffee", plus({ stock_ledger: "view" })), owners);
    expect(Object.keys(s.stock)).toEqual(Object.keys(full.stock));
    expect(s.menu).toEqual(full.menu);
    expect(s.adjustments).toEqual(full.adjustments);
    expect(s.bills.length).toBeGreaterThan(0);
    expect(s.bills.every((b) => b.loc === "coffee")).toBe(true);
    expect(s.bills).toEqual(own.bills);
    expect(s.sales).toEqual(own.sales);
    // Nor the documents: the ledger decides none of them.
    expect(s.req).toEqual(own.req);
    expect(s.tkt).toEqual(own.tkt);
  });
  it("each shelf feature widens the shelves; Items & stock the tickets too, Menus the new-product asks", () => {
    for (const f of ["items_stock", "stock_ledger", "inventory", "prices", "menu"] as const) {
      const s = scope(full, as("counter", "coffee", plus({ [f]: "view" })), owners);
      expect(s.stock, f).toEqual(full.stock);
      expect(s.rsv, f).toEqual(full.rsv);
      expect(s.ovr, f).toEqual(full.ovr);
      expect(s.menu, f).toEqual(full.menu);
      expect(s.bills, f).toEqual(own.bills);
      expect(s.req, f).toEqual(own.req);
    }
    expect(scope(full, as("counter", "coffee", plus({ items_stock: "view" })), owners).tkt.map((t) => t.id)).toEqual(full.tkt.map((t) => t.id));
    expect(scope(full, as("counter", "coffee", plus({ menu: "view" })), owners).productReqs).toEqual(full.productReqs);
    expect(scope(full, as("counter", "coffee", plus({ prices: "view" })), owners).productReqs).toEqual(own.productReqs);
  });
  it("a manager-desk role without every outlet is cut to its home outlet's bills and takings", () => {
    const perms: Permissions = { ...DESK_DEFAULTS.manager.perms, a: ["void_bill", "void_settlement"] };
    const s = scope(full, as("manager", "coffee", perms), owners);
    expect(s.bills.length).toBeGreaterThan(0);
    expect(s.bills.every((b) => b.loc === "coffee")).toBe(true);
    expect(s.bills.length).toBeLessThan(full.bills.length);
    expect(s.sales.every((row) => Object.keys(row).every((k) => k === "coffee"))).toBe(true);
    // Its Approvals and Items & stock still read every outlet's documents and shelves.
    expect(s.req).toEqual(full.req);
    expect(s.stock).toEqual(full.stock);
    // A manager-desk role holding nothing wide reads its home outlet's shelf as a counter would.
    const bare = scope(full, as("manager", "rest", { f: { billing: "view" }, a: [] }), owners);
    expect(Object.keys(bare.stock)).toEqual(["rest"]);
    expect(bare.req.every((r) => r.from === "rest")).toBe(true);
  });
  it("a counter or manager role without Bills reads no till roll; the back office reads it whole", () => {
    const noTill = scope(full, as("counter", "coffee", { f: { outlet_stock: "edit" }, a: [] }), owners);
    expect(noTill.bills).toEqual([]);
    expect(noTill.sales).toEqual(full.sales.map(() => ({})));
    expect(noTill.dayLabels).toEqual(full.dayLabels);
    const creditOnly = scope(full, as("manager", "rest", { f: { credit: "edit", settlements: "edit" }, a: ["void_settlement", "all_outlets"] }), owners);
    expect(creditOnly.bills).toEqual([]);
    expect(creditOnly.roster).toEqual(full.roster);
    const store = scope(full, as("store", "store", { f: {}, a: [] }), owners);
    expect(store.bills.map((b) => b.no)).toEqual(full.bills.map((b) => b.no));
    expect(store.sales).toEqual(full.sales);
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
  it("names on bills, the roster and the rate card go with Bills or either half of Credit, not with the desk", () => {
    const strip = (b: Bill[]) => b.filter((x) => x.payer || x.customerName).length;
    // A counter role without the till and without credit: names stripped.
    const noTill = scope(full, as("counter", "coffee", { f: { outlet_stock: "edit" }, a: [] }), owners);
    expect(strip(scopePayers(full.bills, as("counter", "coffee", { f: { outlet_stock: "edit" }, a: [] })))).toBe(0);
    expect(noTill.roster).toEqual({ staff: [], depts: [], doctors: [] });
    expect(noTill.terms).toEqual(noTerms());
    // A store role given either half of credit reads them.
    for (const f of ["credit", "settlements"] as const) {
      const store = as("store", "store", { f: { ...DESK_DEFAULTS.store.perms.f, [f]: "view" }, a: [] });
      expect(strip(scopePayers(full.bills, store)), f).toBeGreaterThan(0);
      expect(scope(full, store, owners).roster, f).toEqual(full.roster);
      expect(scope(full, store, owners).terms, f).toEqual(full.terms);
    }
    expect(strip(scope(full, as("store", "store"), owners).bills)).toBe(0);
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
    expect(Object.keys(scopeStock(part, as("counter", "kiosk", plus({ approvals: "edit" }))).stock)).toEqual(["kiosk"]);
  });
});
