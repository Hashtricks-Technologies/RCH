import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import * as FX from "@rch/contract/fixtures";
import { setAccessToken } from "../api/session";
import { hydrateMaster, IT } from "../data/master";
import {
  inTransit, inTransitIndex, madeItems, onOrder, onOrderIndex,
} from "../lib/selectors";
import StoreDashboard from "../roles/store/Dashboard";
import StoreRequisitions from "../roles/store/Requisitions";
import StoreAdjustments from "../roles/store/Adjustments";
import MenuManagement from "../roles/manager/MenuManagement";
import MakeDistribute from "../roles/prod/MakeDistribute";
import Drawer from "../ui/Drawer";
import "../roles/buyer/PoReceiptDrawer";        // registers "bgrn" on the drawer registry
import "../roles/buyer/NewProductDrawer";       // registers "bnewitem"
import "../roles/buyer/ContractDrawer";         // registers "bcontract"
import "../roles/manager/ApprovalDrawer";       // registers "mreq"
import "../roles/counter/AdjustmentRequestForm"; // registers "creqadj"
import "../roles/counter/AdjustmentRequestDrawer"; // registers "cadjreq"
import "../roles/manager/AdjustmentRequestDrawer"; // registers "madjreq"
import { useApp } from "../store";
import { as, resetStore, S } from "./fixture";

/**
 * The store, kitchen and buyer screens, against the defects the audit found in them: a
 * catalogue key nothing answers to, a kitchen that could only make three things, a decimal
 * quantity that could not be typed, and two per-row walks folded into one pass.
 *
 * Nothing here re-asserts a rule the server owns. What it pins is what the *screen* does with
 * what it is handed.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn();
type Stubs = Record<string, () => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return make
      ? Promise.resolve(make())
      : Promise.resolve(json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const calls = () =>
  fetchMock.mock.calls.map((c) => {
    const [u, init] = c as [string, RequestInit];
    return {
      at: `${init.method} ${String(u).split("?")[0]}`,
      body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
    };
  });
const hit = (at: string) => calls().filter((c) => c.at === at);

function mountNode(node: ComponentType) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(node))); });
  return {
    host,
    text: () => host.textContent ?? "",
    button: (starts: string) =>
      [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(starts)),
    field: (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!,
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
/** Typing, the way React hears it. */
const type = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
/** Leaving a field - React maps `onBlur` onto the bubbling `focusout`. */
const leave = (el: HTMLInputElement) => { el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); };
/** A textarea's own value setter, the way React hears typing into one. */
const typeArea = (el: HTMLTextAreaElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
/** Choosing from a `<select>`, the way React hears it. */
const pick = (el: HTMLSelectElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const settle = async (fn: () => void) => {
  await act(async () => { fn(); await new Promise((r) => { setTimeout(r, 0); }); });
};
const settleUntil = async (ok: () => boolean, tries = 200, ms = 8000) => {
  const until = Date.now() + ms;
  for (let i = 0; (i < tries || Date.now() < until) && !ok(); i += 1) {
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
  }
  if (!ok()) throw new Error(`the action never settled: still false after ${tries} turns and ${ms}ms`);
};

beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setAccessToken("tok");
});
afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); });

describe("a catalogue key nothing answers to", () => {
  it("a stock key absent from the catalogue renders the dashboard without throwing", () => {
    as("store");
    // What a snapshot taken while another browser was adding a product looks like: the ledger
    // carries a line for a key this browser's item master has never seen.
    useApp.setState({ stock: { ...S().stock, store: { ...S().stock.store, ghost: 12 } } });

    const ui = mountNode(StoreDashboard);
    expect(ui.text()).toContain("Store keeper dashboard");
    // The unknown key is left out of every count rather than taking the screen down with it.
    expect(ui.text()).not.toContain("ghost");
    ui.unmount();
  });
});

describe("what the kitchen can make", () => {
  it("a fourth FG appears on the Make tiles", () => {
    as("prod");
    // A finished good the kitchen batches onto its own rack, added to the master the way
    // `applyItems` adds one - in place, with the catalogue signal bumped.
    hydrateMaster({
      items: { ...FX.IT, bun: { c: "FG-4004", n: "Masala bun", u: "nos", t: "FG", g: "Bakery", hsn: "2106", gst: 5, rl: 0, cost: 14, sl: 10 } },
      locations: FX.LOC,
      prices: FX.PL, priceLists: FX.PRICE_LISTS, menu: FX.MENU, users: FX.USERS,
    });
    useApp.setState((s) => ({ catalogVersion: s.catalogVersion + 1 }));

    expect(madeItems()).toContain("bun");
    const ui = mountNode(MakeDistribute);
    expect(ui.field("Quantity of Masala bun to start")).toBeTruthy();
    ui.unmount();
  });

  it("an MTO item (capp) does NOT", () => {
    as("prod");
    // Cappuccino is never batched: it is made at the counter, cup by cup, and the kitchen holds
    // no stock of it at all.
    expect(IT.capp.t).toBe("MTO");
    expect(madeItems()).not.toContain("capp");

    const ui = mountNode(MakeDistribute);
    expect(ui.field("Quantity of Cappuccino to start")).toBeNull();
    ui.unmount();
  });
});

describe("a decimal quantity on a requisition line", () => {
  it("typing \"12.5\" into a requisition line posts 12.5", async () => {
    as("store");
    S().setPrqDraft([{ it: "milk", qty: 0 }]);
    serve({
      "POST /api/v1/requisitions": () => json({
        result: { ...FX.seedPrq[0] }, changed: ["prq"],
        message: "PRQ-2026-016 sent to procurement - 1 line",
      }),
      "GET /api/v1/requisitions": () => json(FX.seedPrq),
    });
    const ui = mountNode(StoreRequisitions);

    const box = ui.field("Quantity of Milk 1L (toned)");
    // Every keystroke on the way to 12.5, exactly as the store keeper types it. Read one at a
    // time, "1" and "12" and "12." would each have landed on the draft - and "12." is 12.
    act(() => { type(box, "1"); });
    act(() => { type(box, "12"); });
    act(() => { type(box, "12."); });
    act(() => { type(box, "12.5"); });
    // Nothing has reached the draft yet: the box holds what is typed until it is left.
    expect(S().prqDraft[0].qty).toBe(0);

    act(() => { leave(box); });
    expect(S().prqDraft[0].qty).toBe(12.5);

    await settle(() => { ui.button("Send to procurement")!.click(); });
    await settleUntil(() => hit("POST /api/v1/requisitions").length > 0);
    expect(hit("POST /api/v1/requisitions")[0].body).toEqual({
      lines: [{ it: "milk", qty: 12.5 }], note: "",
    });
    ui.unmount();
  });

  // The same defect one screen over, and the one place it costs paise rather than half-litres:
  // the add-contract rate is stepped 0.01, and `Number(e.target.value)` on every keystroke read
  // "12." as 12 and "12.0" as 12, so a rate typed digit by digit was agreed at the rupee.
  it("typing \"12.05\" into the add-contract rate posts 12.05", async () => {
    as("buyer");
    const vendor = FX.seedVendors.find((v) => v.active)!;
    serve({
      "POST /api/v1/contracts": () => json({
        result: FX.seedContracts()[0], changed: ["contracts"],
        message: `Rate contract agreed with ${vendor.n}`,
      }),
      "GET /api/v1/contracts": () => json(FX.seedContracts()),
    });
    useApp.setState({ drawer: { t: "bcontract", id: "new" } });
    const ui = mountNode(Drawer);

    act(() => { pick(ui.host.querySelectorAll("select")[0], vendor.id); });
    act(() => { type(ui.host.querySelector<HTMLInputElement>('input[aria-label="Valid from"]')!, "2026-10-01"); });
    act(() => { type(ui.host.querySelector<HTMLInputElement>('input[aria-label="Valid to"]')!, "2027-03-31"); });

    const box = ui.field("Contract rate for item 1");
    for (const keyed of ["1", "12", "12.", "12.0", "12.05"]) act(() => { type(box, keyed); });
    act(() => { leave(box); });

    await settle(() => { ui.button("Add 1 contract")!.click(); });
    await settleUntil(() => hit("POST /api/v1/contracts").length > 0);
    expect(hit("POST /api/v1/contracts")[0].body).toMatchObject({
      vendorId: vendor.id, rate: 12.05, from: "2026-10-01", to: "2027-03-31", moq: 0,
    });
    ui.unmount();
  });
});

describe("the goods receipt refuses rather than greys out", () => {
  /** The seeded order the store keeper is receiving against, and the only line on it. */
  const openPo = () => FX.seedPo.find((o) => o.st === "Ordered" || o.st === "Partially received")!;

  it("a line rejecting more than arrived is refused, and books again once it is corrected", async () => {
    as("buyer");
    const po = openPo();
    const line = po.lines[0];
    serve({
      [`POST /api/v1/purchase-orders/${po.id}/receive`]: () => json({
        result: { po: { ...po, st: "Received" }, grns: [] },
        changed: ["po", "grn", "stock"],
        message: "Booked into Central Store",
      }),
      "GET /api/v1/purchase-orders": () => json(FX.seedPo),
      "GET /api/v1/grns": () => json(FX.seedGrn),
      "GET /api/v1/stock": () => json({ stock: {}, rsv: {}, ovr: {} }),
    });
    useApp.setState({ drawer: { t: "bgrn", id: po.id } });
    const ui = mountNode(Drawer);

    const named = IT[line.it]?.n ?? line.it;
    act(() => { type(ui.field("Delivery note number"), "DC-77001"); });
    // More turned away than ever arrived. Committed, so the screen has really taken it.
    const rejected = ui.field(`Quantity rejected for ${named}`);
    act(() => { type(rejected, "9999"); });
    act(() => { leave(rejected); });

    // The button is still live - a disabled one never receives the press that would commit the
    // correction below, so it could never be re-enabled. It refuses with a sentence instead.
    const book = ui.button("Book into the central store")!;
    expect(book.disabled).toBe(false);
    await settle(() => { book.click(); });
    expect(S().toast).toBe(`${named} - more was rejected than arrived on that line.`);
    expect(hit(`POST /api/v1/purchase-orders/${po.id}/receive`)).toHaveLength(0);

    // Corrected and committed, the same button books.
    act(() => { type(rejected, "0"); });
    act(() => { leave(rejected); });
    await settle(() => { ui.button("Book into the central store")!.click(); });
    await settleUntil(() => hit(`POST /api/v1/purchase-orders/${po.id}/receive`).length > 0);
    ui.unmount();
  });
});

describe("procurement adds a product with the store keeper's field set", () => {
  /** The box a visible label names. `Field` wires the label's `htmlFor` to its control. */
  const byLabel = <T extends HTMLElement>(host: HTMLElement, label: string): T => {
    const l = [...host.querySelectorAll("label")].find((x) => x.textContent === label);
    expect(l, `no field labelled ${label}`).toBeTruthy();
    return document.getElementById(l!.htmlFor) as T;
  };

  it("offers only the types procurement buys", () => {
    as("buyer");
    useApp.setState({ drawer: { t: "bnewitem", id: "new" } });
    const ui = mountNode(Drawer);
    // FG is the kitchen's and MTO is made at the counter; neither is bought.
    const types = [...byLabel<HTMLSelectElement>(ui.host, "Type").options].map((o) => o.value);
    expect(types).toEqual(["RAW", "PACK", "MRP"]);
    // The group box suggests the groups already on the master, so one is not typed two ways.
    const list = byLabel<HTMLInputElement>(ui.host, "Group").list!;
    expect([...list.options].map((o) => o.value)).toContain("Packaging");
    ui.unmount();
  });

  it("fills in the GST rate when an HSN code is picked from the list", () => {
    as("buyer");
    useApp.setState({ drawer: { t: "bnewitem", id: "new" } });
    const ui = mountNode(Drawer);

    const hsnSelect = byLabel<HTMLSelectElement>(ui.host, "HSN");
    act(() => { pick(hsnSelect, "2202"); }); // aerated and soft drinks, 28% GST
    expect(byLabel<HTMLInputElement>(ui.host, "GST %").value).toBe("28");

    // Still editable afterwards - the picker only fills in a starting value.
    act(() => { type(byLabel(ui.host, "GST %"), "12"); });
    expect(byLabel<HTMLInputElement>(ui.host, "GST %").value).toBe("12");
    ui.unmount();
  });

  it("posts the group, HSN and GST it typed, not the defaults, and no code - the server assigns it", async () => {
    as("buyer");
    const sheet = { c: "PK-2010", n: "Butter paper sheet", u: "nos", t: "PACK" as const, g: "Packaging", hsn: "4806", gst: 18, rl: 0, cost: 0.8 };
    serve({
      "POST /api/v1/items": () => json({ result: { key: "butterpapers", item: sheet }, changed: ["items"], message: "Butter paper sheet added to the catalogue" }),
      "GET /api/v1/items": () => json({ ...FX.IT, butterpapers: sheet }),
    });
    useApp.setState({ drawer: { t: "bnewitem", id: "new" } });
    const ui = mountNode(Drawer);

    act(() => { type(byLabel(ui.host, "Product name"), "Butter paper sheet"); });
    act(() => { pick(byLabel(ui.host, "Type"), "PACK"); });
    // The code is previewed, read-only: one past the highest PK- code the master already holds.
    expect(byLabel<HTMLInputElement>(ui.host, "Item code").value).toBe("PK-2003");
    expect(byLabel<HTMLInputElement>(ui.host, "Item code").readOnly).toBe(true);
    act(() => { type(byLabel(ui.host, "Group"), "Packaging"); });
    // The paperboard grade this sheet is graded under is not on the curated list, so the
    // operator switches the HSN field from the picker to typing the code by hand.
    const notListed = [...ui.host.querySelectorAll("label")]
      .find((l) => l.textContent === "Not on the list - type the code myself")!.querySelector("input")!;
    act(() => { notListed.click(); });
    act(() => { type(byLabel(ui.host, "HSN"), "4806"); });
    act(() => { type(byLabel(ui.host, "GST %"), "18"); });
    act(() => { type(byLabel(ui.host, "Cost a unit (₹)"), "0.8"); });

    await settle(() => { ui.button("Add to the catalogue")!.click(); });
    await settleUntil(() => hit("POST /api/v1/items").length > 0);
    expect(hit("POST /api/v1/items")[0].body).toMatchObject({
      name: "Butter paper sheet", type: "PACK", grp: "Packaging", hsn: "4806", gst: 18,
      cost: 0.8, loc: "store", opening: 0,
    });
    expect(hit("POST /api/v1/items")[0].body).not.toHaveProperty("code");
    ui.unmount();
  });
});

describe("menu management adds several products to a till at once", () => {
  it("posts one call per product picked, and clears only the ones that saved", async () => {
    as("manager");
    // Mutated as each POST lands, so the GET readback - and so the picker built off it - moves
    // the same way a real server's would once a product is actually on the till.
    const menu = { ...FX.MENU, coffee: [...FX.MENU.coffee] };
    let refuseSand = true;
    serve({
      "POST /api/v1/menus/coffee/items": (() => {
        let n = 0;
        return () => {
          n++;
          // "puff" (first picked, alphabetically before "sand") lists cleanly; "sand" is refused
          // once, as if another manager had just listed it, and would be retried by hand.
          if (n === 1) {
            menu.coffee = [...menu.coffee, "puff"];
            return json({ result: { loc: "coffee", items: menu.coffee }, changed: ["menu"], message: "Veg puffs listed at Coffee Shop" });
          }
          if (refuseSand) { refuseSand = false; return json({ error: { code: "conflict", message: "Veg sandwich is already on this till" } }, 409); }
          menu.coffee = [...menu.coffee, "sand"];
          return json({ result: { loc: "coffee", items: menu.coffee }, changed: ["menu"], message: "Veg sandwich listed at Coffee Shop" });
        };
      })(),
      "GET /api/v1/menus": () => json(menu),
    });
    const ui = mountNode(MenuManagement);

    act(() => { pick(ui.host.querySelector("select")!, "coffee"); });
    act(() => { ui.host.querySelector<HTMLInputElement>('input[aria-label="Select Veg puffs"]')!.click(); });
    act(() => { ui.host.querySelector<HTMLInputElement>('input[aria-label="Select Veg sandwich"]')!.click(); });

    await settle(() => { ui.button("Add 2 products")!.click(); });
    await settleUntil(() => hit("POST /api/v1/menus/coffee/items").length >= 2);
    expect(hit("POST /api/v1/menus/coffee/items").map((c) => (c.body as { it: string }).it)).toEqual(["puff", "sand"]);

    // Puff saved and dropped off the pick list; the refused sandwich stayed picked, ready to retry.
    expect(ui.host.querySelector<HTMLInputElement>('input[aria-label="Select Veg sandwich"]')!.checked).toBe(true);
    expect(ui.host.querySelector('input[aria-label="Select Veg puffs"]')).toBeNull();

    await settle(() => { ui.button("Add 1 product")!.click(); });
    await settleUntil(() => hit("POST /api/v1/menus/coffee/items").length >= 3);
    ui.unmount();
  });
});

describe("menu management shows the whole menu and takes a product off it", () => {
  /** The rows of the "On the … till" table, which is the first table on the page. */
  const menuRows = (host: HTMLElement) =>
    [...host.querySelectorAll("table")[0].querySelectorAll("tbody tr")];

  it("lists what the outlet already sells, and removes one behind a second press", async () => {
    as("manager");
    // The screen could only ever *add*: what a till already sold was nowhere on it, so a
    // product listed by mistake could not be found, let alone taken off.
    const menu = { ...FX.MENU, coffee: [...FX.MENU.coffee] };
    serve({
      "DELETE /api/v1/menus/coffee/items/juice": () => {
        menu.coffee = menu.coffee.filter((k) => k !== "juice");
        return json({ result: { loc: "coffee", items: menu.coffee }, changed: ["menu"], message: "Real Juice 200ml removed from Coffee Shop" });
      },
      "GET /api/v1/menus": () => json(menu),
    });
    const ui = mountNode(MenuManagement);
    act(() => { pick(ui.host.querySelector("select")!, "coffee"); });

    // Every product on the till has a row, with what it is charged on the outlet's own list.
    expect(menuRows(ui.host)).toHaveLength(FX.MENU.coffee.length);
    const row = menuRows(ui.host).find((r) => (r.textContent ?? "").includes("Real Juice 200ml"))!;
    expect(row.textContent).toContain("₹");

    // One press arms it, and nothing has been sent yet: a till emptied by a mis-click is not
    // something a confirm-less button may do.
    const press = (within: Element, starts: string) =>
      [...within.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(starts))!;
    await settle(() => { press(row, "Remove").click(); });
    expect(hit("DELETE /api/v1/menus/coffee/items/juice")).toHaveLength(0);

    await settle(() => { press(menuRows(ui.host).find((r) => (r.textContent ?? "").includes("Real Juice 200ml"))!, "Confirm removal").click(); });
    await settleUntil(() => !menu.coffee.includes("juice"));
    expect(hit("DELETE /api/v1/menus/coffee/items/juice")).toHaveLength(1);
    expect(S().toast).toBe("Real Juice 200ml removed from Coffee Shop");
    // And the refetched menu is what the table redraws from, so the row is gone.
    expect(menuRows(ui.host).some((r) => (r.textContent ?? "").includes("Real Juice 200ml"))).toBe(false);
    ui.unmount();
  });
});

describe("the store keeper's adjustments", () => {
  it("offers only the central store and quarantine - the two shelves the server lets it adjust", () => {
    as("store");
    const ui = mountNode(StoreAdjustments);
    const options = [...ui.host.querySelector("select")!.querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toEqual(["Central Store", "Quarantine"]);
    ui.unmount();
  });
});

describe("menu management offers only what the outlet's list prices", () => {
  it("leaves an unpriced product off the picker and says how many are waiting on a price", () => {
    as("manager");
    const { salad: _gone, ...rest } = S().prices["PL-002"];
    void _gone;
    useApp.setState({ prices: { ...S().prices, "PL-002": rest } });
    serve({ "GET /api/v1/menus": () => json(FX.MENU) });
    const ui = mountNode(MenuManagement);
    act(() => { pick(ui.host.querySelector("select")!, "coffee"); });

    // The server refuses to list a product at no price, so the picker does not offer one.
    expect(ui.host.querySelector('input[aria-label="Select Garden salad"]')).toBeNull();
    expect(ui.host.querySelector('input[aria-label="Select Veg sandwich"]')).not.toBeNull();
    expect(ui.text()).toContain("1 more product has no price on list");
    // Raw materials and packing are never offered at all.
    expect(ui.host.querySelector('input[aria-label="Select Milk 1L (toned)"]')).toBeNull();
    ui.unmount();
  });
});

describe("the manager can redirect an undecided request to a peer outlet", () => {
  it("posts the picked outlet and closes the drawer once it lands", async () => {
    as("manager");
    serve({
      "POST /api/v1/requests/REQ-2026-0911/redirect": () => json({
        result: {
          request: { id: "REQ-2026-0911", from: "coffee", by: "Kavitha Raman", at: "09:14", lines: [{ it: "milk", qty: 20, appr: 20, short: 0 }], st: "Ticket issued", ticket: "TKT-0501", mgrNote: "", urg: true, hist: [{ s: "Request sent", who: "Kavitha Raman", t: "09:14" }, { s: "Redirected to The Restaurant", who: "Ramesh Kumar", t: "10:02" }] },
          ticket: { id: "TKT-0501", req: "REQ-2026-0911", from: "rest", to: "coffee", lines: [{ it: "milk", qty: 20 }], st: "Issued", by: "Ramesh Kumar", at: "10:02", otp: "" },
        },
        changed: ["req", "tkt", "rsv"],
        message: "TKT-0501 issued - The Restaurant covers this request instead of the central store",
      }),
      "GET /api/v1/requests": () => json([]),
      "GET /api/v1/tickets": () => json([]),
      "GET /api/v1/stock": () => json({ stock: {}, rsv: {}, ovr: {} }),
    });
    useApp.setState({ drawer: { t: "mreq", id: "REQ-2026-0911" } });
    const ui = mountNode(Drawer);

    expect(ui.text()).toContain("Fulfil from another outlet instead");
    await settle(() => { ui.button("Redirect from")!.click(); });
    await settleUntil(() => hit("POST /api/v1/requests/REQ-2026-0911/redirect").length > 0);
    // "rest" is the first peer offered - "coffee" (the request's own outlet) is excluded.
    expect(hit("POST /api/v1/requests/REQ-2026-0911/redirect")[0].body).toEqual({ from: "rest" });
    ui.unmount();
  });
});

describe("a counter raises an adjustment request, and the outlet manager decides it", () => {
  it("raises against its own outlet, with no location to pick", async () => {
    as("counter");
    serve({
      "POST /api/v1/adjustment-requests": () => json({
        result: {
          id: "ADJREQ-2026-05", loc: "coffee", reason: "wastage", note: "", by: "Kavitha Raman",
          at: "09:20", lines: [{ it: "cup", qty: -3 }], st: "Request sent",
          hist: [{ s: "Request sent", who: "Kavitha Raman", t: "09:20" }],
        },
        changed: ["adjReq"], message: "ADJREQ-2026-05 sent to the outlet manager",
      }),
      "GET /api/v1/adjustment-requests": () => json([]),
    });
    useApp.setState({ drawer: { t: "creqadj", id: "new" } });
    const ui = mountNode(Drawer);

    expect(ui.text()).toContain("GOES TO THE OUTLET MANAGER");
    await settle(() => { ui.button("Add line")!.click(); });
    const itemKey = ui.host.querySelector<HTMLSelectElement>('select[aria-label="Item on line 1"]')!.value;
    const qtyField = ui.field(`Quantity of ${IT[itemKey].n}`);
    await settle(() => { type(qtyField, "3"); });
    await settle(() => { ui.button("Send to the outlet manager")!.click(); });
    await settleUntil(() => hit("POST /api/v1/adjustment-requests").length > 0);

    expect(hit("POST /api/v1/adjustment-requests")[0].body).toEqual({
      reason: "wastage", note: "", lines: [{ it: itemKey, qty: -3 }],
    });
    ui.unmount();
  });

  it("the outlet manager approves it, which writes the ADJ- document in the same step", async () => {
    as("manager");
    serve({
      "POST /api/v1/adjustment-requests/ADJREQ-2026-01/approve": () => json({
        result: {
          request: { id: "ADJREQ-2026-01", loc: "coffee", reason: "wastage", note: "Fridge failed overnight", by: "Kavitha Raman", at: "09:10", lines: [{ it: "cup", qty: -20 }], st: "Approved", apprBy: "Ramesh Kumar", adjId: "ADJ-2026-0011", hist: [{ s: "Request sent", who: "Kavitha Raman", t: "09:10" }, { s: "Approved", who: "Ramesh Kumar", t: "09:30" }] },
          adjustment: { id: "ADJ-2026-0011", loc: "coffee", reason: "wastage", note: "Fridge failed overnight", by: "Ramesh Kumar", at: "09:30", lines: [{ it: "cup", qty: -20 }] },
        },
        changed: ["adjReq", "stock", "adjustments"],
        message: "ADJREQ-2026-01 approved - ADJ-2026-0011 - 20 nos written off at Coffee Shop (wastage)",
      }),
      "GET /api/v1/adjustment-requests": () => json([]),
      "GET /api/v1/stock": () => json({ stock: {}, rsv: {}, ovr: {} }),
      "GET /api/v1/adjustments": () => json([]),
    });
    useApp.setState({ drawer: { t: "madjreq", id: "ADJREQ-2026-01" } });
    const ui = mountNode(Drawer);

    await settle(() => { ui.button("Approve & correct the shelf")!.click(); });
    await settleUntil(() => hit("POST /api/v1/adjustment-requests/ADJREQ-2026-01/approve").length > 0);
    expect(S().toast).toBe("ADJREQ-2026-01 approved - ADJ-2026-0011 - 20 nos written off at Coffee Shop (wastage)");
    ui.unmount();
  });

  it("the outlet manager rejects it with a reason, which stays locked without one", async () => {
    as("manager");
    serve({
      "POST /api/v1/adjustment-requests/ADJREQ-2026-01/reject": () => json({
        result: { id: "ADJREQ-2026-01", loc: "coffee", reason: "wastage", note: "Fridge failed overnight", by: "Kavitha Raman", at: "09:10", lines: [{ it: "cup", qty: -20 }], st: "Rejected", apprBy: "Ramesh Kumar", hist: [{ s: "Request sent", who: "Kavitha Raman", t: "09:10" }, { s: "Rejected", who: "Ramesh Kumar", t: "09:31" }] },
        changed: ["adjReq"], message: "ADJREQ-2026-01 rejected",
      }),
      "GET /api/v1/adjustment-requests": () => json([]),
    });
    useApp.setState({ drawer: { t: "madjreq", id: "ADJREQ-2026-01" } });
    const ui = mountNode(Drawer);

    expect(ui.button("Reject")!.hasAttribute("disabled")).toBe(true);
    const note = ui.host.querySelector<HTMLTextAreaElement>("textarea")!;
    await settle(() => { typeArea(note, "Count it again before writing it off."); });
    await settle(() => { ui.button("Reject")!.click(); });
    await settleUntil(() => hit("POST /api/v1/adjustment-requests/ADJREQ-2026-01/reject").length > 0);
    expect(hit("POST /api/v1/adjustment-requests/ADJREQ-2026-01/reject")[0].body).toEqual({ note: "Count it again before writing it off." });
    ui.unmount();
  });
});

describe("the indexed selectors", () => {
  /** Every key either registry knows about, so an item with no claim and no ticket is covered
   *  too - the map has no entry for it and the reader has to answer 0. */
  const everyItem = () => [...new Set([...Object.keys(IT), "ghost"])];

  it("onOrderIndex equals onOrder for every item", () => {
    const s = { prq: S().prq, po: S().po };
    const index = onOrderIndex(s);
    // Not a vacuous pass: the seeded hospital really does have quantity on order.
    expect([...index.values()].some((v) => v > 0)).toBe(true);
    for (const it of everyItem()) {
      expect(index.get(it) ?? 0, `onOrder mismatch for ${it}`).toBe(onOrder(s, it));
    }
  });

  it("inTransitIndex equals inTransit for every item", () => {
    // The seeded tickets need at least one that has actually been handed over, or the two
    // agreeing on zero everywhere proves nothing.
    const tkt = S().tkt.map((t, i) => (i === 0 ? { ...t, st: "Collected" as const } : t));
    useApp.setState({ tkt });
    const s = { tkt };
    const index = inTransitIndex(s);
    expect([...index.values()].some((v) => v > 0)).toBe(true);
    for (const it of everyItem()) {
      expect(index.get(it) ?? 0, `inTransit mismatch for ${it}`).toBe(inTransit(s, it));
    }
  });
});
