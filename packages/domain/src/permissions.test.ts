import { describe, expect, it } from "vitest";
import { act, anyOf, desk, need, routes, type Access, type Permissions, type Role, type RouteName } from "@rch/contract";
import { ACTIONS, admits, can, DESK_DEFAULTS, FEATURES, grantRefusal, holds, permissionRefusal, readsHospitalWide } from "./permissions";

const DESKS: readonly Role[] = ["counter", "manager", "store", "prod", "buyer"];
const none: Permissions = { f: {}, a: [] };

/**
 * Today's role list for every role-listed route in the manifest, written out by hand. The first test
 * below pins it to the manifest as it stands, so this is the access the seeded roles must reproduce.
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
};

/**
 * What each of those routes will need once the manifest moves off role lists - the table Wave 3
 * copies into `packages/contract/src/routes.ts`. Any-of lists put the hospital-wide need first.
 * `xReport`, `zReports` and `closeRegister` also take `admitAdmin: true` in the manifest.
 */
const TARGET_ACCESS: Partial<Record<RouteName, Access>> = {
  priceLists: need("prices", "view"),
  savePrice: need("prices", "edit"),
  createPriceList: need("prices", "edit"),
  deletePriceList: need("prices", "edit"),
  setOutletPriceList: need("prices", "edit"),
  saveOutletPrices: need("prices", "edit"),
  addMenuItem: need("menu", "edit"),
  removeMenuItem: need("menu", "edit"),
  approveRequest: need("approvals", "edit"),
  rejectRequest: need("approvals", "edit"),
  redirectRequest: need("approvals", "edit"),
  approveAdjustmentRequest: need("approvals", "edit"),
  rejectAdjustmentRequest: need("approvals", "edit"),
  setClassTerms: need("credit", "edit"),
  setPayerTerms: need("credit", "edit"),
  recordSettlement: need("credit", "edit"),
  statement: need("credit", "view"),
  voidSettlement: act("void_settlement"),
  voidBill: act("void_bill"),
  approveRequisition: need("requisitions", "edit"),
  declineRequisition: need("requisitions", "edit"),
  addToProcurementList: need("procurement_list", "edit"),
  createPo: need("procurement_list", "edit"),
  updatePoLine: need("purchase_orders", "edit"),
  removePoLine: need("purchase_orders", "edit"),
  patchPo: need("purchase_orders", "edit"),
  sendPo: need("purchase_orders", "edit"),
  cancelPo: need("purchase_orders", "edit"),
  closePoShort: need("purchase_orders", "edit"),
  receivePo: need("goods_receipt", "edit"),
  addVendor: need("vendors", "edit"),
  updateVendor: need("vendors", "edit"),
  addContract: need("rate_contracts", "edit"),
  updateContract: need("rate_contracts", "edit"),
  removeContract: need("rate_contracts", "edit"),
  pay: need("billing", "edit"),
  askShop: need("outlet_requests", "edit"),
  answerShopAsk: need("outlet_requests", "edit"),
  declineShopAsk: need("outlet_requests", "edit"),
  createAdjustmentRequest: need("outlet_stock", "edit"),
  currentShift: desk("counter"),
  closeShift: desk("counter"),
  dispatchProdOrder: need("kitchen_orders", "edit"),
  setOrderStatus: need("kitchen_orders", "edit"),
  distribute: need("make_distribute", "edit"),
  makeBatch: need("make_distribute", "edit"),
  issueTicket: need("issue_desk", "edit"),
  createRequisition: need("store_requisitions", "edit"),
  createRequest: anyOf(need("outlet_requests", "edit"), need("kitchen_requests", "edit")),
  cancelRequest: anyOf(need("approvals", "edit"), need("outlet_requests", "edit"), need("kitchen_requests", "edit")),
  handover: anyOf(need("issue_desk", "edit"), need("kitchen_tickets", "edit"), need("outlet_tickets", "edit")),
  receiveTicket: anyOf(need("issue_desk", "edit"), need("kitchen_tickets", "edit"), need("outlet_tickets", "edit")),
  cancelTicket: anyOf(need("issue_desk", "edit"), need("kitchen_tickets", "edit"), need("outlet_tickets", "edit")),
  transfer: anyOf(need("items_stock", "edit"), need("outlet_tickets", "edit")),
  createProductRequest: anyOf(need("menu", "edit"), need("outlet_requests", "edit")),
  // The manager raises a kitchen order from the Dashboard, not from Items & stock, so the
  // manager's half stays on Approvals - the desk that decides what an outlet is sent.
  createProdOrder: anyOf(need("approvals", "edit"), need("outlet_requests", "edit")),
  cancelAdjustmentRequest: anyOf(need("approvals", "edit"), need("outlet_stock", "edit")),
  toggleAvail: need("availability", "edit"),
  setItemImage: need("item_photos", "edit"),
  removeItemImage: need("item_photos", "edit"),
  createItem: need("item_master", "edit"),
  patchItem: anyOf(need("items_stock", "edit"), need("item_master", "edit")),
  answerProductRequest: anyOf(need("new_products", "edit"), need("store_requisitions", "edit")),
  createAdjustment: need("adjustments", "edit"),
  stockLedger: need("stock_ledger", "view"),
  creditReport: anyOf(need("credit", "view"), need("billing", "edit")),
  xReport: need("x_report", "view"),
  zReports: need("z_report", "view"),
  closeRegister: need("z_report", "edit"),
};

/** The deliberate change: nobody but the super admin closes or reads Z until a role is given it. */
const Z_ROUTES = new Set(["zReports", "closeRegister"]);

const roleListed = () => Object.entries(routes).filter(([, r]) => Array.isArray(r.access)).map(([k]) => k).sort();

describe("the parity tables", () => {
  it("LEGACY_ACCESS is the manifest's role lists today, route for route", () => {
    expect(Object.keys(LEGACY_ACCESS).sort()).toEqual(roleListed());
    for (const [k, r] of Object.entries(routes)) if (Array.isArray(r.access)) expect(r.access, k).toEqual(LEGACY_ACCESS[k]);
  });

  it("TARGET_ACCESS covers every role-listed route in the manifest, and nothing else", () => {
    expect(Object.keys(TARGET_ACCESS).sort()).toEqual(roleListed());
  });
});

describe("the seeded roles reproduce today's access", () => {
  for (const r of Object.keys(LEGACY_ACCESS)) {
    for (const d of DESKS) {
      const expected = Z_ROUTES.has(r) ? false : LEGACY_ACCESS[r].includes(d);
      it(`${r} × ${d} → ${expected}`, () => {
        expect(admits(TARGET_ACCESS[r as RouteName]!, d, DESK_DEFAULTS[d].perms).ok).toBe(expected);
      });
    }
  }

  it("the Z is nobody's: a seeded counter or manager reaches neither the Z list nor the close", () => {
    for (const d of ["counter", "manager"] as const) {
      expect(admits(TARGET_ACCESS.zReports!, d, DESK_DEFAULTS[d].perms)).toEqual({ ok: false, status: 404, message: "There is nothing here." });
      expect(admits(TARGET_ACCESS.closeRegister!, d, DESK_DEFAULTS[d].perms).ok).toBe(false);
    }
    for (const d of DESKS) expect(can(DESK_DEFAULTS[d].perms, "z_report")).toBe(false);
  });

  it("on the dual-scope routes the seeded manager runs hospital-wide and the seeded counter at its own outlet", () => {
    for (const r of ["transfer", "createProductRequest", "createProdOrder", "cancelRequest", "cancelAdjustmentRequest", "xReport"] as const) {
      expect(admits(TARGET_ACCESS[r]!, "manager", DESK_DEFAULTS.manager.perms), r).toEqual({ ok: true, wide: true });
      expect(admits(TARGET_ACCESS[r]!, "counter", DESK_DEFAULTS.counter.perms), r).toEqual({ ok: true, wide: false });
    }
  });

  it("reads hospital-wide for every seeded desk but the counter", () => {
    expect(DESKS.filter((d) => readsHospitalWide(d, DESK_DEFAULTS[d].perms))).toEqual(["manager", "store", "prod", "buyer"]);
  });
});

describe("DESK_DEFAULTS", () => {
  it("names the five seeded roles", () => {
    expect(DESKS.map((d) => DESK_DEFAULTS[d].name)).toEqual(["Counter Operator", "Outlet Manager", "Store Keeper", "Kitchen In-charge", "Procurement Officer"]);
  });

  it("holds exactly what each desk had", () => {
    expect(DESK_DEFAULTS.counter.perms).toEqual({
      f: { billing: "edit", availability: "edit", item_photos: "edit", outlet_stock: "edit", outlet_requests: "edit", outlet_tickets: "edit", x_report: "view" },
      a: [],
    });
    expect(DESK_DEFAULTS.manager.perms).toEqual({
      f: {
        billing: "view", x_report: "view", shift_reports: "view", stock_ledger: "view",
        credit: "edit", approvals: "edit", items_stock: "edit", menu: "edit", prices: "edit", availability: "edit", item_photos: "edit",
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
  it("catalogues thirty-four features in seven sections", () => {
    expect(Object.keys(FEATURES)).toHaveLength(34);
    expect([...new Set(Object.values(FEATURES).map((f) => f.section))]).toEqual(["Sales", "Outlets", "My counter", "Central store", "Kitchen", "Purchasing", "Items"]);
    expect(FEATURES.billing.levels).toEqual({ view: ["counter", "manager"], edit: ["counter"] });
    expect(FEATURES.availability.levels).toEqual({ edit: ["counter", "manager", "prod"] });
    expect(Object.entries(FEATURES).filter(([, f]) => f.scope === "wide").map(([k]) => k)).toEqual([
      "shift_reports", "credit", "approvals", "items_stock", "menu", "prices",
      "requisitions", "procurement_list", "purchase_orders", "rate_contracts", "vendors", "new_products", "inventory", "stock_ledger",
    ]);
  });

  it("hangs each action off the feature it voids, and every outlet off the two desks that sell", () => {
    expect(ACTIONS.void_bill.parent).toBe("billing");
    expect(ACTIONS.void_settlement.parent).toBe("credit");
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
    expect(grantRefusal("store", { f: {}, a: ["void_settlement"] })).toBe(`"Void a settlement" needs at least view access to Credit & settlements.`);
    expect(grantRefusal("store", { f: { credit: "view" }, a: ["void_settlement"] })).toBeNull();
  });
});

describe("admits", () => {
  const counter = DESK_DEFAULTS.counter.perms;
  it("lets everybody through public and any, and nobody through admin", () => {
    expect(admits("public", "store", none)).toEqual({ ok: true, wide: false });
    expect(admits("any", "manager", DESK_DEFAULTS.manager.perms)).toEqual({ ok: true, wide: true });
    expect(admits("admin", "manager", DESK_DEFAULTS.manager.perms)).toEqual({ ok: false, status: 404, message: "There is nothing here." });
  });
  it("reads a role list and a desk list by desk alone", () => {
    expect(admits(["counter", "manager"], "counter", none)).toEqual({ ok: true, wide: false });
    expect(admits(["counter", "manager"], "manager", none)).toEqual({ ok: true, wide: true });
    expect(admits(["counter"], "store", counter).ok).toBe(false);
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
    expect(admits(TARGET_ACCESS.transfer!, "counter", both)).toEqual({ ok: true, wide: true });
    expect(admits(TARGET_ACCESS.transfer!, "counter", { f: { outlet_tickets: "edit" }, a: ["all_outlets"] })).toEqual({ ok: true, wide: true });
  });
  it("keeps the first refusal sentence when no need is met", () => {
    const p: Permissions = { f: { approvals: "view", outlet_stock: "view" }, a: [] };
    expect(admits(TARGET_ACCESS.cancelAdjustmentRequest!, "counter", p)).toEqual({ ok: false, status: 403, message: permissionRefusal("approvals") });
  });
});

describe("readsHospitalWide", () => {
  it("is every desk but the counter, and a counter given every outlet or a hospital-wide feature", () => {
    expect(readsHospitalWide("store", none)).toBe(true);
    expect(readsHospitalWide("counter", none)).toBe(false);
    expect(readsHospitalWide("counter", { f: {}, a: ["all_outlets"] })).toBe(true);
    expect(readsHospitalWide("counter", { f: { stock_ledger: "view" }, a: [] })).toBe(true);
    expect(readsHospitalWide("counter", { f: { billing: "edit", item_photos: "edit" }, a: [] })).toBe(false);
  });
});

describe("permissionRefusal", () => {
  it("names the feature and says what to ask for", () => {
    expect(permissionRefusal("prices")).toBe("You can see Prices but not change them - ask the administrator for edit access.");
    expect(permissionRefusal("credit")).toBe("You can see Credit & settlements but not change them - ask the administrator for edit access.");
  });
});
