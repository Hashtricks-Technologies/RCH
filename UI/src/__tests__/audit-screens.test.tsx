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
import MakeDistribute from "../roles/prod/MakeDistribute";
import Drawer from "../ui/Drawer";
import "../roles/buyer/PoReceiptDrawer";        // registers "bgrn" on the drawer registry
import "../roles/buyer/NewProductDrawer";       // registers "bnewitem"
import "../roles/buyer/ContractDrawer";         // registers "bcontract"
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

  it("posts the code, group, HSN and GST it typed, not the defaults", async () => {
    as("buyer");
    const sheet = { c: "PK-2010", n: "Butter paper sheet", u: "nos", t: "PACK" as const, g: "Packaging", hsn: "4806", gst: 18, rl: 0, cost: 0.8 };
    serve({
      "POST /api/v1/items": () => json({ result: { key: "butterpapers", item: sheet }, changed: ["items"], message: "Butter paper sheet added to the catalogue" }),
      "GET /api/v1/items": () => json({ ...FX.IT, butterpapers: sheet }),
    });
    useApp.setState({ drawer: { t: "bnewitem", id: "new" } });
    const ui = mountNode(Drawer);

    act(() => { type(byLabel(ui.host, "Product name"), "Butter paper sheet"); });
    act(() => { type(byLabel(ui.host, "Item code"), "PK-2010"); });
    act(() => { pick(byLabel(ui.host, "Type"), "PACK"); });
    act(() => { type(byLabel(ui.host, "Group"), "Packaging"); });
    act(() => { type(byLabel(ui.host, "HSN"), "4806"); });
    act(() => { type(byLabel(ui.host, "GST %"), "18"); });
    act(() => { type(byLabel(ui.host, "Cost a unit (₹)"), "0.8"); });

    await settle(() => { ui.button("Add to the catalogue")!.click(); });
    await settleUntil(() => hit("POST /api/v1/items").length > 0);
    expect(hit("POST /api/v1/items")[0].body).toMatchObject({
      name: "Butter paper sheet", code: "PK-2010", type: "PACK", grp: "Packaging", hsn: "4806", gst: 18,
      cost: 0.8, loc: "store", opening: 0,
    });
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
