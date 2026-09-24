import { describe, expect, it } from "vitest";
import { act, desk, need, routes, type Access, type Feature, type Permissions, type Role, type RouteName } from "@rch/contract";
import { ACTIONS, admits, can, DESK_DEFAULTS, FEATURES, grantRefusal, holds, permissionRefusal, readsBills, readsWide, type ReadCollection } from "./permissions";

const DESKS: readonly Role[] = ["counter", "manager", "store", "prod", "buyer"];
const none: Permissions = { f: {}, a: [] };
const COLLECTIONS: readonly ReadCollection[] = ["bills", "stock", "requests", "tickets", "shopAsks", "prodOrders", "adjReq", "productReqs"];

/**
 * The role list every permission-gated route carried before roles were configurable, written out by
 * hand and frozen. The seeded roles must reproduce it through the manifest as it stands, route for
 * route and desk for desk - the only change being the Z, which is nobody's.
 */
const LEGACY_ACCESS: Record<string, readonly Role[]> = {
  priceLists: ["manager"],
  pay: ["counter"],
  toggleAvail: ["counter", "manager", "prod"],
  savePrice: ["manager"],
  createPriceList: ["manager"],
  deletePriceList: ["manager"],
  setOutletPriceList: ["manager"],
  saveOutletPrices: ["manager"],
  addMenuItem: ["manager"],
  removeMenuItem: ["manager"],
  createRequest: ["counter", "prod"],
  cancelRequest: ["counter", "prod", "manager"],
  approveRequest: ["manager"],
  rejectRequest: ["manager"],
  redirectRequest: ["manager"],
  issueTicket: ["store"],
  handover: ["store", "prod", "counter"],
  receiveTicket: ["counter", "store", "prod"],
  transfer: ["counter", "manager"],
  askShop: ["counter"],
  answerShopAsk: ["counter"],
  declineShopAsk: ["counter"],
  dispatchProdOrder: ["prod"],
  distribute: ["prod"],
  setOrderStatus: ["prod"],
  makeBatch: ["prod"],
  cancelTicket: ["store", "prod", "counter"],
  createRequisition: ["store"],
  approveRequisition: ["buyer"],
  declineRequisition: ["buyer"],
  addToProcurementList: ["buyer"],
  createPo: ["buyer"],
  updatePoLine: ["buyer"],
  removePoLine: ["buyer"],
  patchPo: ["buyer"],
  sendPo: ["buyer"],
  cancelPo: ["buyer"],
  receivePo: ["buyer", "store"],
  closePoShort: ["buyer"],
  addVendor: ["buyer"],
  updateVendor: ["buyer"],
  addContract: ["buyer"],
  updateContract: ["buyer"],
  removeContract: ["buyer"],
  createItem: ["store", "prod", "buyer"],
  createProductRequest: ["counter", "manager"],
  answerProductRequest: ["store", "buyer"],
  stockLedger: ["store", "manager", "buyer", "prod"],
  creditReport: ["counter", "manager"],
  xReport: ["counter", "manager"],
  closeRegister: ["counter", "manager"],
  zReports: ["counter", "manager"],
  currentShift: ["counter"],
  closeShift: ["counter"],
  setClassTerms: ["manager"],
  setPayerTerms: ["manager"],
  statement: ["manager"],
  recordSettlement: ["manager"],
  voidSettlement: ["manager"],
  patchItem: ["manager", "store", "buyer", "prod"],
  setItemImage: ["manager", "counter"],
  removeItemImage: ["manager", "counter"],
  voidBill: ["manager"],
  createAdjustment: ["store", "prod"],
  createAdjustmentRequest: ["counter"],
  cancelAdjustmentRequest: ["counter", "manager"],
  approveAdjustmentRequest: ["manager"],
  rejectAdjustmentRequest: ["manager"],
  createProdOrder: ["counter", "manager"],
  // ---- QR ordering: not legacy, but the seeded roles' access from the day it shipped - the
  // counter works the queue, the manager watches it and retries a refund the gateway refused.
  qrOrders: ["counter", "manager"],
  setQrOrderStatus: ["counter"],
  setQrPause: ["counter"],
  retryQrRefund: ["manager"],
};

/** The deliberate change: nobody but the super admin closes or reads Z until a role is given it. */
const Z_ROUTES = new Set(["zReports", "closeRegister"]);

/** Every route a desk or a permission gates - what used to be a role list. */
const gated = () => Object.entries(routes).filter(([, r]) => typeof r.access !== "string").map(([k]) => k).sort();
const accessOf = (r: string): Access => routes[r as RouteName].access;

describe("the parity table", () => {
  it("LEGACY_ACCESS names every route the manifest gates by desk or permission, and nothing else", () => {
    expect(Object.keys(LEGACY_ACCESS).sort()).toEqual(gated());
  });
});

describe("the seeded roles reproduce today's access", () => {
  for (const r of Object.keys(LEGACY_ACCESS)) {
    for (const d of DESKS) {
      const expected = Z_ROUTES.has(r) ? false : LEGACY_ACCESS[r].includes(d);
      it(`${r} × ${d} → ${expected}`, () => {
        expect(admits(accessOf(r), d, DESK_DEFAULTS[d].perms).ok).toBe(expected);
      });
    }
  }

  it("the Z is nobody's: a seeded counter or manager reaches neither the Z list nor the close", () => {
    for (const d of ["counter", "manager"] as const) {
      expect(admits(routes.zReports.access, d, DESK_DEFAULTS[d].perms)).toEqual({ ok: false, status: 404, message: "There is nothing here." });
      expect(admits(routes.closeRegister.access, d, DESK_DEFAULTS[d].perms).ok).toBe(false);
    }
    for (const d of DESKS) expect(can(DESK_DEFAULTS[d].perms, "z_report")).toBe(false);
  });

  it("on the dual-scope routes the seeded manager runs hospital-wide and the seeded counter at its own outlet", () => {
    for (const r of ["transfer", "createProductRequest", "createProdOrder", "cancelRequest", "cancelAdjustmentRequest", "xReport"] as const) {
      expect(admits(routes[r].access, "manager", DESK_DEFAULTS.manager.perms), r).toEqual({ ok: true, wide: true });
      expect(admits(routes[r].access, "counter", DESK_DEFAULTS.counter.perms), r).toEqual({ ok: true, wide: false });
    }
  });

  it("reads every collection hospital-wide for every seeded desk but the counter, which reads none", () => {
    for (const c of COLLECTIONS) {
      expect(DESKS.filter((d) => readsWide(d, DESK_DEFAULTS[d].perms, c)), c).toEqual(["manager", "store", "prod", "buyer"]);
    }
  });

  it("reads the till roll on every seeded desk", () => {
    for (const d of DESKS) expect(readsBills(d, DESK_DEFAULTS[d].perms), d).toBe(true);
  });

  it("answers the seeded manager 404, not 403, on the till it can never be given", () => {
    expect(admits(routes.pay.access, "manager", DESK_DEFAULTS.manager.perms)).toEqual({ ok: false, status: 404, message: "There is nothing here." });
  });
});

describe("DESK_DEFAULTS", () => {
  it("names the five seeded roles", () => {
    expect(DESKS.map((d) => DESK_DEFAULTS[d].name)).toEqual(["Counter Operator", "Outlet Manager", "Store Keeper", "Kitchen In-charge", "Procurement Officer"]);
  });

  it("holds exactly what each desk had", () => {
    expect(DESK_DEFAULTS.counter.perms).toEqual({
      f: { billing: "edit", availability: "edit", item_photos: "edit", outlet_stock: "edit", outlet_requests: "edit", outlet_tickets: "edit", qr_orders: "edit", x_report: "view" },
      a: [],
    });
    expect(DESK_DEFAULTS.manager.perms).toEqual({
      f: {
        billing: "view", x_report: "view", shift_reports: "view", stock_ledger: "view", qr_orders: "view",
        credit: "edit", settlements: "edit", approvals: "edit", items_stock: "edit", menu: "edit", prices: "edit", availability: "edit", item_photos: "edit",
      },
      a: ["void_bill", "void_settlement", "all_outlets"],
    });
    expect(DESK_DEFAULTS.store.perms).toEqual({
      f: { issue_desk: "edit", store_requisitions: "edit", adjustments: "edit", goods_receipt: "edit", item_master: "edit", store_stock: "view", store_reports: "view", stock_ledger: "view" },
      a: [],
    });
    expect(DESK_DEFAULTS.prod.perms).toEqual({
      f: {
        kitchen_orders: "edit", make_distribute: "edit", kitchen_requests: "edit", kitchen_tickets: "edit", availability: "edit", adjustments: "edit", item_master: "edit",
        kitchen_stock: "view", stock_ledger: "view",
      },
      a: [],
    });
    expect(DESK_DEFAULTS.buyer.perms).toEqual({
      f: {
        requisitions: "edit", procurement_list: "edit", purchase_orders: "edit", rate_contracts: "edit", vendors: "edit", goods_receipt: "edit", item_master: "edit", new_products: "edit",
        inventory: "view", stock_ledger: "view",
      },
      a: [],
    });
  });

  it("gives every seeded role only what its desk may be given", () => {
    for (const d of DESKS) expect(grantRefusal(d, DESK_DEFAULTS[d].perms), d).toBeNull();
  });
});

describe("FEATURES and ACTIONS", () => {
  it("catalogues thirty-six features in seven sections", () => {
    expect(Object.keys(FEATURES)).toHaveLength(36);
    expect([...new Set(Object.values(FEATURES).map((f) => f.section))]).toEqual(["Sales", "Outlets", "My counter", "Central store", "Kitchen", "Purchasing", "Items"]);
    expect(FEATURES.billing.levels).toEqual({ view: ["counter", "manager"], edit: ["counter"] });
    expect(FEATURES.availability.levels).toEqual({ edit: ["counter", "manager", "prod"] });
    expect(FEATURES.qr_orders).toEqual({ label: "QR orders", section: "Sales", scope: "local", levels: { view: ["counter", "manager"], edit: ["counter", "manager"] } });
    expect(Object.entries(FEATURES).filter(([, f]) => f.scope === "wide").map(([k]) => k)).toEqual([
      "shift_reports", "credit", "settlements", "approvals", "items_stock", "menu", "prices",
      "requisitions", "procurement_list", "purchase_orders", "rate_contracts", "vendors", "new_products", "inventory", "stock_ledger",
    ]);
  });

  it("hangs each action off the feature it voids, and every outlet off the two desks that sell", () => {
    expect(ACTIONS.void_bill.parent).toBe("billing");
    expect(ACTIONS.void_settlement.parent).toBe("settlements");
    expect(ACTIONS.all_outlets.desks).toEqual(["counter", "manager"]);
  });
});

describe("can and holds", () => {
  const p: Permissions = { f: { prices: "view", menu: "edit" }, a: ["void_bill"] };
  it("reads edit as view too, and view as nothing more", () => {
    expect(can(p, "menu")).toBe(true);
    expect(can(p, "menu", "edit")).toBe(true);
    expect(can(p, "prices", "view")).toBe(true);
    expect(can(p, "prices", "edit")).toBe(false);
    expect(can(p, "credit")).toBe(false);
  });
  it("reads an action as held or not", () => {
    expect(holds(p, "void_bill")).toBe(true);
    expect(holds(p, "void_settlement")).toBe(false);
  });
});

describe("grantRefusal", () => {
  it("names the first feature and level the desk may not be given", () => {
    expect(grantRefusal("store", { f: { billing: "view" }, a: [] })).toBe("The store desk can't be given view access to Bills.");
    expect(grantRefusal("manager", { f: { billing: "edit" }, a: [] })).toBe("The outlet manager desk can't be given edit access to Bills.");
    expect(grantRefusal("counter", { f: { availability: "view" }, a: [] })).toBe("The counter desk can't be given view access to Product on / off.");
    expect(grantRefusal("prod", { f: { goods_receipt: "edit" }, a: [] })).toBe("The kitchen desk can't be given edit access to Goods receipt.");
  });
  it("lets any desk hold a hospital-wide feature", () => {
    for (const d of DESKS) expect(grantRefusal(d, { f: { prices: "edit", stock_ledger: "view", inventory: "view" }, a: [] }), d).toBeNull();
  });
  it("refuses an action outside its desks, or held without its parent feature", () => {
    expect(grantRefusal("buyer", { f: {}, a: ["all_outlets"] })).toBe(`The purchasing desk can't be given "Works for every outlet".`);
    expect(grantRefusal("manager", { f: {}, a: ["void_bill"] })).toBe(`"Void a bill" needs at least view access to Bills.`);
    expect(grantRefusal("store", { f: {}, a: ["void_settlement"] })).toBe(`"Void a settlement" needs at least view access to Receivables & settlements.`);
    expect(grantRefusal("store", { f: { credit: "edit" }, a: ["void_settlement"] })).toBe(`"Void a settlement" needs at least view access to Receivables & settlements.`);
    expect(grantRefusal("store", { f: { settlements: "view" }, a: ["void_settlement"] })).toBeNull();
  });
});

describe("admits", () => {
  const counter = DESK_DEFAULTS.counter.perms;
  it("lets everybody through public and any, and nobody through admin", () => {
    expect(admits("public", "store", none)).toEqual({ ok: true, wide: false });
    expect(admits("any", "manager", DESK_DEFAULTS.manager.perms)).toEqual({ ok: true, wide: true });
    expect(admits("admin", "manager", DESK_DEFAULTS.manager.perms)).toEqual({ ok: false, status: 404, message: "There is nothing here." });
  });
  it("reads a desk list by desk alone", () => {
    expect(admits(desk("counter", "manager"), "manager", none)).toEqual({ ok: true, wide: false });
    expect(admits(desk("counter"), "store", counter).ok).toBe(false);
    expect(admits(desk("counter"), "counter", none)).toEqual({ ok: true, wide: false });
    expect(admits(desk("counter"), "counter", { f: {}, a: ["all_outlets"] })).toEqual({ ok: true, wide: true });
    expect(admits(desk("counter"), "manager", DESK_DEFAULTS.manager.perms)).toEqual({ ok: false, status: 404, message: "There is nothing here." });
  });
  it("answers 403 with the sentence when the feature is held at view but edit is needed", () => {
    const viewer: Permissions = { f: { prices: "view" }, a: [] };
    expect(admits(need("prices", "edit"), "manager", viewer)).toEqual({ ok: false, status: 403, message: "You can see Prices but not change them - ask the administrator for edit access." });
    expect(admits(need("prices", "view"), "manager", viewer)).toEqual({ ok: true, wide: true });
  });
  it("answers 403 when the parent feature is held but the action is not, and 404 when neither is", () => {
    expect(admits(act("void_bill"), "counter", counter)).toEqual({ ok: false, status: 403, message: ACTIONS.void_bill.refusal });
    expect(admits(act("void_settlement"), "counter", counter)).toEqual({ ok: false, status: 404, message: "There is nothing here." });
    expect(admits(act("all_outlets"), "counter", counter)).toEqual({ ok: false, status: 404, message: "There is nothing here." });
    expect(admits(act("void_bill"), "manager", DESK_DEFAULTS.manager.perms)).toEqual({ ok: true, wide: true });
  });
  it("takes the first need met, so the hospital-wide one decides the scope when both are held", () => {
    const both: Permissions = { f: { items_stock: "edit", outlet_tickets: "edit" }, a: [] };
    expect(admits(routes.transfer.access, "counter", both)).toEqual({ ok: true, wide: true });
    expect(admits(routes.transfer.access, "counter", { f: { outlet_tickets: "edit" }, a: ["all_outlets"] })).toEqual({ ok: true, wide: true });
  });
  it("lets the seeded manager watch the QR queue but not work it, and tells it what to ask for", () => {
    expect(admits(routes.qrOrders.access, "manager", DESK_DEFAULTS.manager.perms)).toEqual({ ok: true, wide: true });
    expect(admits(routes.setQrOrderStatus.access, "manager", DESK_DEFAULTS.manager.perms)).toEqual({ ok: false, status: 403, message: permissionRefusal("qr_orders") });
    expect(admits(routes.setQrOrderStatus.access, "counter", counter)).toEqual({ ok: true, wide: false });
  });
  it("answers 404, not 403, when the desk could never be given the level or the action", () => {
    // The till's edit is the counter's alone: a manager holding Bills at view is not told to ask.
    expect(admits(need("billing", "edit"), "manager", { f: { billing: "view" }, a: [] })).toEqual({ ok: false, status: 404, message: "There is nothing here." });
    expect(admits(need("billing", "edit"), "counter", { f: { billing: "view" }, a: [] })).toEqual({ ok: false, status: 403, message: permissionRefusal("billing") });
    // An action outside its desks: every outlet is the counter's and the manager's to be given.
    expect(admits(act("all_outlets"), "store", none).ok).toBe(false);
    // The parent held and the action grantable: a 403 on any desk.
    expect(admits(act("void_settlement"), "store", { f: { settlements: "view" }, a: [] })).toEqual({ ok: false, status: 403, message: ACTIONS.void_settlement.refusal });
    expect(admits(act("void_settlement"), "store", { f: { credit: "edit" }, a: [] })).toEqual({ ok: false, status: 404, message: "There is nothing here." });
  });
  it("keeps the first refusal sentence when no need is met", () => {
    const p: Permissions = { f: { approvals: "view", outlet_stock: "view" }, a: [] };
    expect(admits(routes.cancelAdjustmentRequest.access, "counter", p)).toEqual({ ok: false, status: 403, message: permissionRefusal("approvals") });
  });
});

describe("readsWide and readsBills", () => {
  it("reads every collection hospital-wide on the three back-office desks, whatever they hold", () => {
    for (const d of ["store", "prod", "buyer"] as const) for (const c of COLLECTIONS) expect(readsWide(d, none, c), `${d} ${c}`).toBe(true);
  });
  it("widens every collection of a counter or manager desk with every outlet, and none without", () => {
    for (const d of ["counter", "manager"] as const) {
      for (const c of COLLECTIONS) {
        expect(readsWide(d, none, c), `${d} ${c}`).toBe(false);
        expect(readsWide(d, { f: {}, a: ["all_outlets"] }, c), `${d} ${c}`).toBe(true);
      }
    }
  });
  it("cuts a manager-desk role without every outlet to its home outlet's till roll", () => {
    const noAll: Permissions = { ...DESK_DEFAULTS.manager.perms, a: ["void_bill", "void_settlement"] };
    expect(readsWide("manager", noAll, "bills")).toBe(false);
    expect(readsWide("manager", noAll, "stock")).toBe(true);
    expect(readsWide("manager", noAll, "requests")).toBe(true);
  });
  it("never widens the till roll with a hospital-wide feature - the leak a ledger grant used to open", () => {
    const wideAll: Permissions = { f: Object.fromEntries(Object.entries(FEATURES).filter(([, f]) => f.scope === "wide").map(([k]) => [k, "view"])), a: [] };
    expect(readsWide("counter", { f: { stock_ledger: "view" }, a: [] }, "bills")).toBe(false);
    expect(readsWide("counter", wideAll, "bills")).toBe(false);
  });
  it("widens each collection with the features whose screens read it across the outlets", () => {
    const wide = (f: Feature) => COLLECTIONS.filter((c) => readsWide("counter", { f: { [f]: "view" }, a: [] }, c));
    for (const f of ["stock_ledger", "inventory", "prices"] as const) expect(wide(f), f).toEqual(["stock"]);
    expect(wide("items_stock")).toEqual(["stock", "tickets"]);
    expect(wide("menu")).toEqual(["stock", "productReqs"]);
    expect(wide("approvals")).toEqual(["requests", "tickets", "shopAsks", "prodOrders", "adjReq", "productReqs"]);
    expect(wide("credit")).toEqual([]);
    expect(wide("settlements")).toEqual([]);
    expect(wide("requisitions")).toEqual([]);
  });
  it("reads the till roll with Bills on a counter or manager desk, and always on the back office", () => {
    expect(readsBills("counter", { f: { outlet_stock: "edit" }, a: [] })).toBe(false);
    expect(readsBills("manager", { f: { credit: "edit", settlements: "edit" }, a: ["all_outlets"] })).toBe(false);
    expect(readsBills("manager", { f: { billing: "view" }, a: [] })).toBe(true);
    expect(readsBills("store", none)).toBe(true);
  });
});

describe("permissionRefusal", () => {
  it("names the feature and says what to ask for", () => {
    expect(permissionRefusal("prices")).toBe("You can see Prices but not change them - ask the administrator for edit access.");
    expect(permissionRefusal("credit")).toBe("You can see Discounts & credit limits but not change them - ask the administrator for edit access.");
    expect(permissionRefusal("settlements")).toBe("You can see Receivables & settlements but not change them - ask the administrator for edit access.");
  });
});
