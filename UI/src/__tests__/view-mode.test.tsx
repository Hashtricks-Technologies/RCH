import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESK_DEFAULTS, permissionRefusal } from "@rch/domain";
import type { Action, Feature, Permissions, Role } from "@rch/contract";
import { useApp } from "../store";
import { DRAWERS } from "../drawers";
import { userHolds } from "../lib/selectors";
import "../registry";
import type { Settlement } from "../types";
import { deskScreens, resetStore, userOf } from "./fixture";

/**
 * View-only mode: a role that holds a screen's feature at `view` sees the screen - with a "View
 * only" badge on its heading - and none of the controls that would write. At `edit` the same
 * controls are there. The server refuses the write either way (`admits` in `@rch/domain`); this
 * pins that the screen does not offer one it would refuse.
 *
 * Each role is its desk's seeded role with one grant moved, so everything else it holds stays
 * exactly what the seeded role has.
 */

beforeEach(resetStore);
const mounted: (() => void)[] = [];
afterEach(() => { while (mounted.length) mounted.pop()!(); });

type Grant = "edit" | "view" | "none";
/** Sign in as `desk`'s seeded role with `f` moved to `level`, and `actions` in place of its own. */
function signIn(desk: Role, f: Feature, level: Grant, actions?: Action[]): void {
  const perms: Permissions = JSON.parse(JSON.stringify(DESK_DEFAULTS[desk].perms)) as Permissions;
  if (level === "none") delete perms.f[f]; else perms.f[f] = level;
  if (actions) perms.a = actions;
  act(() => { useApp.setState({ user: { ...userOf(desk), perms }, auth: "ready" }); });
}

function mount<P extends object>(C: ComponentType<P>, props: P = {} as P) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(C, props))); });
  mounted.push(() => { act(() => { root.unmount(); }); host.remove(); });
  const labels = () => [...host.querySelectorAll("button")].map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim());
  return {
    host,
    labels,
    has: (label: string) => labels().includes(label),
    pill: () => [...host.querySelectorAll(".pill")].some((p) => p.textContent === "View only"),
    click: (label: string) => {
      const b = [...host.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim() === label)!;
      act(() => { b.click(); });
    },
    /** Every box whose accessible name starts with `prefix`. */
    inputs: (prefix: string) => [...host.querySelectorAll<HTMLInputElement>(`input[aria-label^="${prefix}"]`)],
  };
}

/** Let a read the screen started as it mounted settle inside `act`. */
const settle = () => act(async () => { await Promise.resolve(); });

/** A screen by its key on the desk's own sidebar, or a drawer by its registry key and id. */
type Target = { screen: string } | { drawer: string; id: string };
const open = (desk: Role, t: Target) =>
  "screen" in t ? mount(deskScreens(desk)[t.screen as never]) : mount(DRAWERS[t.drawer], { id: t.id });

/**
 * [what, desk, feature, where, the write controls present at edit and absent at view].
 * A screen also wears the badge at view; a drawer is a document opened from one that does.
 */
const CASES: [string, Role, Feature, Target, string[]][] = [
  // ---- the outlet manager's
  ["Approvals", "manager", "approvals", { screen: "approvals" }, ["Review"]],
  ["a stock request's approval", "manager", "approvals", { drawer: "mreq", id: "REQ-2026-0911" },
    ["Reject the request", "Approve & forward", "Reject this item", "Redirect from Restaurant"]],
  ["an adjustment request's approval", "manager", "approvals", { drawer: "madjreq", id: "ADJREQ-2026-01" },
    ["Approve & correct the shelf", "Reject", "Withdraw without deciding"]],
  ["Items & stock", "manager", "items_stock", { screen: "items-stock" }, ["Edit"]],
  ["Menu management", "manager", "menu", { screen: "menu" },
    ["Remove", "Select all", "Raise new-product request"]],
  ["Credit (who owes what)", "manager", "settlements", { screen: "credit" }, []],
  // ---- the counter's
  ["Stock in hand", "counter", "outlet_stock", { screen: "outlet-stock" }, ["Request adjustment"]],
  ["an adjustment request", "counter", "outlet_stock", { drawer: "cadjreq", id: "ADJREQ-2026-01" }, ["Cancel request"]],
  ["Stock requests", "counter", "outlet_requests", { screen: "outlet-requests" },
    ["Add item", "Submit request", "Decline", "Send 6 nos"]],
  ["a stock request", "counter", "outlet_requests", { drawer: "creq", id: "REQ-2026-0911" }, ["Cancel request"]],
  ["Pick tickets", "counter", "outlet_tickets", { screen: "outlet-tickets" }, []],
  // The step buttons are per order and the queue starts empty here; `qr-orders.test.tsx` pins
  // them, and the pause switch shut at view.
  ["QR orders", "counter", "qr_orders", { screen: "qr-orders" }, []],
  ["a pick ticket", "counter", "outlet_tickets", { drawer: "ctkt", id: "TKT-0440" }, ["Confirm receipt"]],
  // ---- the central store's
  ["the Issue desk", "store", "issue_desk", { screen: "issue" }, ["Generate ticket", "Take OTP"]],
  ["an issue", "store", "issue_desk", { drawer: "sissue", id: "REQ-2026-0910" }, ["Generate ticket"]],
  ["a store ticket", "store", "issue_desk", { drawer: "stkt", id: "TKT-0440" }, ["Hand over on OTP", "Cancel ticket"]],
  ["Adjustments", "store", "adjustments", { screen: "adjust" }, ["Add line", "Record adjustment"]],
  ["Store requisitions", "store", "store_requisitions", { screen: "procure" },
    ["Fill from below-reorder items", "Send to procurement", "Discard"]],
  // ---- the kitchen's
  ["Kitchen orders", "prod", "kitchen_orders", { screen: "kitchen-orders" }, ["Accept", "Decline", "Start making"]],
  ["a kitchen order", "prod", "kitchen_orders", { drawer: "pord", id: "PRD-2026-029" }, ["Accept order", "Decline"]],
  ["Make & distribute", "prod", "make_distribute", { screen: "make" }, ["Enter a quantity"]],
  ["Kitchen requests", "prod", "kitchen_requests", { screen: "kitchen-requests" }, ["Add item", "Submit request"]],
  ["Kitchen tickets", "prod", "kitchen_tickets", { screen: "kitchen-tickets" }, []],
  // ---- purchasing
  ["Requisitions", "buyer", "requisitions", { screen: "requisitions" }, ["Approve"]],
  ["a requisition", "buyer", "requisitions", { drawer: "bprq", id: "PRQ-2026-013" }, ["Decline", "Approve 2 item(s)"]],
  ["the Procurement list", "buyer", "procurement_list", { screen: "pool" }, ["Add items", "Raise purchase order"]],
  ["Purchase orders", "buyer", "purchase_orders", { screen: "purchase-orders" }, ["Edit & send"]],
  ["a draft purchase order", "buyer", "purchase_orders", { drawer: "bpo", id: "PO-2026-0140" },
    ["Send to vendor", "Cancel order", "Remove"]],
  ["Rate contracts", "buyer", "rate_contracts", { screen: "contracts" }, ["Add contract", "Edit", "Reopen"]],
  ["Vendors", "buyer", "vendors", { screen: "vendors" }, ["Add vendor"]],
  ["a vendor", "buyer", "vendors", { drawer: "bven", id: "VN-001" }, ["Save", "Deactivate"]],
  ["New products", "buyer", "new_products", { screen: "newproducts" }, ["+ Add product", "Create", "Decline"]],
];

describe("a screen held at view offers nothing that writes", () => {
  it.each(CASES)("%s", async (_what, desk, f, where, writes) => {
    // The Credit screen reads its balances as it mounts; nothing here is about them.
    useApp.setState({ loadReceivables: () => Promise.resolve(true) });

    signIn(desk, f, "edit");
    const edit = open(desk, where);
    await settle();
    for (const w of writes) expect(edit.labels(), `"${w}" at edit`).toContain(w);
    expect(edit.pill()).toBe(false);
    mounted.pop()!();

    signIn(desk, f, "view");
    const view = open(desk, where);
    await settle();
    for (const w of writes) expect(view.labels(), `"${w}" at view`).not.toContain(w);
    if ("screen" in where) expect(view.pill()).toBe(true);
  });

  it("the badge says what to ask for", () => {
    signIn("manager", "prices", "view");
    const ui = open("manager", { screen: "prices" });
    expect(ui.pill()).toBe(true);
    expect(ui.host.textContent).toContain(permissionRefusal("prices"));
  });
});

describe("inputs on a view-only screen are shut, with the reason behind them", () => {
  it("Prices: every cell's switch and price box", () => {
    signIn("manager", "prices", "edit");
    const edit = open("manager", { screen: "prices" });
    const cells = () => [...edit.host.querySelectorAll<HTMLInputElement | HTMLButtonElement>(".cp-cell input, .cp-cell button.sw")];
    expect(cells().length).toBeGreaterThan(0);
    expect(cells().every((c) => !c.disabled)).toBe(true);
    mounted.pop()!();

    signIn("manager", "prices", "view");
    const view = open("manager", { screen: "prices" });
    const shut = [...view.host.querySelectorAll<HTMLInputElement | HTMLButtonElement>(".cp-cell input, .cp-cell button.sw")];
    expect(shut.length).toBeGreaterThan(0);
    expect(shut.every((c) => c.disabled)).toBe(true);
    expect(view.host.querySelector(".cp-bar")).toBeNull();
  });

  it("Credit: the rate card's boxes, its Save and the exception form", async () => {
    useApp.setState({ loadReceivables: () => Promise.resolve(true) });
    signIn("manager", "credit", "edit");
    const edit = open("manager", { screen: "credit" });
    await settle();
    edit.click("Discounts & limits");
    expect(edit.inputs("Discount for").length).toBeGreaterThan(0);
    expect(edit.inputs("Discount for").every((i) => !i.disabled)).toBe(true);
    expect(edit.has("Add the exception")).toBe(true);
    expect(edit.labels()).toContain("Save");
    mounted.pop()!();

    signIn("manager", "credit", "view");
    const view = open("manager", { screen: "credit" });
    await settle();
    view.click("Discounts & limits");
    expect(view.inputs("Discount for").length).toBeGreaterThan(0);
    expect(view.inputs("Discount for").every((i) => i.disabled)).toBe(true);
    expect(view.inputs("Credit limit for").every((i) => i.disabled)).toBe(true);
    expect(view.has("Add the exception")).toBe(false);
    expect(view.labels()).not.toContain("Save");
    expect(view.host.textContent).toContain(permissionRefusal("credit"));
  });

  it("a statement offers no payment to a role that only sees Receivables & settlements", async () => {
    useApp.setState({ readStatement: () => Promise.resolve({
      kind: "doctor", id: "DR-118", name: "Dr A. Rao", outstanding: 300, limit: null, pct: 0,
      open: [{ no: "CF/1101", loc: "rest", at: new Date().toISOString(), total: 300, settled: 0, owed: 300 }], settlements: [],
    }) });
    const read = async (level: Grant) => {
      signIn("manager", "settlements", level);
      const ui = open("manager", { drawer: "stmt", id: "doctor:DR-118" });
      await settle();
      return ui;
    };
    expect((await read("edit")).has("Record the payment")).toBe(true);
    mounted.pop()!();
    const view = await read("view");
    expect(view.has("Record the payment")).toBe(false);
    expect(view.host.textContent).not.toContain("Record a payment");
  });
});

describe("the Credit screen shows the half of it a role holds", () => {
  const views = (ui: ReturnType<typeof open>) =>
    [...ui.host.querySelectorAll('[aria-label="View"] button')].map((b) => b.textContent);

  it("the rate card alone: Discounts & limits only, and no balances read", async () => {
    let reads = 0;
    useApp.setState({ loadReceivables: () => { reads += 1; return Promise.resolve(true); } });
    signIn("manager", "settlements", "none");
    const ui = open("manager", { screen: "credit" });
    await settle();
    expect(views(ui)).toEqual(["Discounts & limits"]);
    expect(ui.inputs("Discount for").length).toBeGreaterThan(0);
    expect(reads).toBe(0);
  });

  it("settlements alone: who owes what and the settlements, and no rate card", async () => {
    let reads = 0;
    useApp.setState({ loadReceivables: () => { reads += 1; return Promise.resolve(true); } });
    signIn("manager", "credit", "none");
    const ui = open("manager", { screen: "credit" });
    await settle();
    expect(views(ui)).toEqual(["Who owes what", "Settlements"]);
    expect(ui.inputs("Discount for")).toHaveLength(0);
    expect(reads).toBe(1);
  });
});

describe("void_settlement gates the settlement's Void", () => {
  const TODAY: Settlement = {
    id: "STL-0007", payer: { kind: "doctor", id: "DR-118", name: "Dr A. Rao" }, amount: 1500,
    mode: "UPI", at: new Date().toISOString(), by: "Ramesh Kumar", lines: [{ no: "CF/1101", amount: 1500 }],
  };
  const settlements = async (actions: Action[]) => {
    useApp.setState({ settlements: [TODAY], loadReceivables: () => Promise.resolve(true) });
    signIn("manager", "settlements", "edit", actions);
    const ui = open("manager", { screen: "credit" });
    await settle();
    ui.click("Settlements");
    return ui;
  };

  it("is offered to a role that holds it", async () => {
    const ui = await settlements(["void_settlement"]);
    expect(userHolds(useApp.getState().user!, "void_settlement")).toBe(true);
    expect(ui.has("Void")).toBe(true);
  });
  it("is not offered to one that does not, even with Receivables & settlements at edit", async () => {
    const ui = await settlements(["void_bill", "all_outlets"]);
    expect(userHolds(useApp.getState().user!, "void_settlement")).toBe(false);
    expect(ui.has("Void")).toBe(false);
    expect(ui.host.textContent).toContain("STL-0007");
  });
  it("is held by the seeded Outlet Manager and nobody else", () => {
    for (const desk of ["counter", "manager", "store", "prod", "buyer"] as const) {
      expect(userHolds(userOf(desk), "void_settlement"), desk).toBe(desk === "manager");
    }
  });
});

describe("edit-only grants: without them the control is gone or shut", () => {
  it("availability: the counter's own switch is shut with the reason on it", () => {
    signIn("counter", "availability", "edit");
    const edit = open("counter", { drawer: "cconfig", id: "juice" });
    const sw = () => edit.host.querySelector<HTMLButtonElement>("button.sw");
    expect(sw()?.disabled).toBe(false);
    mounted.pop()!();

    signIn("counter", "availability", "none");
    const view = open("counter", { drawer: "cconfig", id: "juice" });
    expect(view.host.querySelector<HTMLButtonElement>("button.sw")?.disabled).toBe(true);
    expect(view.host.textContent).toContain(permissionRefusal("availability"));
  });

  it("availability: the kitchen's switch board", () => {
    // Only a role holding the switch reaches the board (`avail` needs availability at edit), so
    // this is the belt behind the sidebar's braces.
    const switches = (level: Grant) => {
      signIn("prod", "availability", level);
      const ui = open("prod", { screen: "avail" });
      const all = [...ui.host.querySelectorAll<HTMLButtonElement>("button.sw")];
      mounted.pop()!();
      return all;
    };
    const on = switches("edit");
    expect(on.length).toBeGreaterThan(0);
    expect(on.every((b) => !b.disabled)).toBe(true);
    expect(switches("none").every((b) => b.disabled)).toBe(true);
  });

  it("item_photos: the counter sees the photo and no way to change it", () => {
    signIn("counter", "item_photos", "edit");
    const edit = open("counter", { drawer: "cconfig", id: "juice" });
    expect(edit.labels().some((l) => /photo/i.test(l))).toBe(true);
    mounted.pop()!();

    signIn("counter", "item_photos", "none");
    const view = open("counter", { drawer: "cconfig", id: "juice" });
    expect(view.labels().some((l) => /photo/i.test(l))).toBe(false);
  });

  it("item_master: no Add product, and the panel says what to ask for", () => {
    signIn("store", "item_master", "edit");
    expect(open("store", { screen: "store-stock" }).has("Add product")).toBe(true);
    expect(open("store", { drawer: "sitem", id: "new" }).has("Add to the catalogue")).toBe(true);
    mounted.pop()!(); mounted.pop()!();

    signIn("store", "item_master", "none");
    const stock = open("store", { screen: "store-stock" });
    expect(stock.has("Add product")).toBe(false);
    const panel = open("store", { drawer: "sitem", id: "new" });
    expect(panel.host.textContent).toContain(permissionRefusal("item_master"));
    expect(panel.has("Add to the catalogue")).toBe(false);
  });

  it("goods_receipt: no Receive on the board, and nothing to book in the receipt", () => {
    signIn("buyer", "goods_receipt", "edit");
    expect(open("buyer", { screen: "purchase-orders" }).has("Receive")).toBe(true);
    expect(open("buyer", { drawer: "bgrn", id: "PO-2026-0141" }).has("Book into the central store")).toBe(true);
    mounted.pop()!(); mounted.pop()!();

    signIn("buyer", "goods_receipt", "none");
    expect(open("buyer", { screen: "purchase-orders" }).has("Receive")).toBe(false);
    expect(open("buyer", { drawer: "bgrn", id: "PO-2026-0141" }).has("Book into the central store")).toBe(false);
  });

  it("adjustments: the kitchen's Write off, and the drawer behind it", () => {
    signIn("prod", "adjustments", "edit");
    expect(open("prod", { screen: "kitchen-stock" }).has("Write off")).toBe(true);
    mounted.pop()!();

    signIn("prod", "adjustments", "view");
    expect(open("prod", { screen: "kitchen-stock" }).has("Write off")).toBe(false);
    const drawer = open("prod", { drawer: "adjstock", id: "kitchen" });
    expect(drawer.host.textContent).toContain(permissionRefusal("adjustments"));
  });

  it("approvals: the manager's Order from the kitchen, and its drawer", () => {
    signIn("manager", "approvals", "edit");
    expect(open("manager", { drawer: "korder", id: "new" }).host.textContent).not.toContain(permissionRefusal("approvals"));
    mounted.pop()!();
    signIn("manager", "approvals", "view");
    expect(open("manager", { drawer: "korder", id: "new" }).host.textContent).toContain(permissionRefusal("approvals"));
  });
});
