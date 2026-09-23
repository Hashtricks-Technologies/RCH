import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { useApp } from "../store";
import Drawer from "../ui/Drawer";
import Prices from "../roles/manager/Prices";
import CounterDashboard from "../roles/counter/Dashboard";
import ManagerDashboard from "../roles/manager/Dashboard";
import "../roles/manager/ItemDrawer";            // registers "item"
import { as, resetStore, S } from "./fixture";
import type { DatedDoc, StockRequest } from "../types";

/**
 * Three things an operator reads off a screen: the tax code they picked, the ceiling they are
 * pricing against, and an alert list that does not run off the page.
 *
 * - **HSN.** The picker was flat on one form and a bare text box on the other, so the same code
 *   was chosen from a list of forty in one place and remembered by heart in the other. Both draw
 *   `hsnGroups` now, and the drawer must never fill in a GST rate for a desk that does not own
 *   the box (`ITEM_FIELD_ROLES` gives `hsn` and `gst` to different people).
 * - **MRP.** The till's cap only appeared on hover, on the one screen that prices against it.
 * - **Alerts.** One banner per open document, uncapped, on lists nothing bounds.
 */

beforeEach(resetStore);
const mounted: (() => void)[] = [];
afterEach(() => { while (mounted.length) mounted.pop()!(); });

function mount(node: ComponentType) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(node))); });
  let live = true;
  const unmount = () => { if (!live) return; live = false; act(() => { root.unmount(); }); host.remove(); };
  mounted.push(unmount);
  return {
    host,
    text: () => host.textContent ?? "",
    /** The box a visible label names - `Field` wires the label's `htmlFor` to its control. */
    field: <T extends HTMLElement>(label: string): T => {
      const l = [...host.querySelectorAll("label")].find((x) => x.textContent === label);
      expect(l, `no field labelled ${label}`).toBeTruthy();
      return document.getElementById(l!.htmlFor) as T;
    },
    alerts: () => [...host.querySelectorAll<HTMLElement>(".al")].map((a) => a.textContent ?? ""),
    /** The headline figure under a KPI's label. */
    kpi: (label: string) => [...host.querySelectorAll<HTMLElement>(".kpi")]
      .find((k) => k.querySelector(".kl")?.textContent === label)
      ?.querySelector(".kv")?.textContent ?? "",
    unmount,
  };
}
const pick = (el: HTMLSelectElement, v: string) => {
  el.value = v;
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const typeIn = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const openItem = (id: string) => {
  const ui = mount(Drawer);
  act(() => { S().openDrawer("item", id); });
  return ui;
};

describe("the HSN box on the item drawer", () => {
  it("is a picker grouped under the headings the domain files the codes by", () => {
    as("store");
    const ui = openItem("juice");                       // Real Juice, HSN 2009 - on the list
    const box = ui.field<HTMLSelectElement>("HSN");
    expect(box.tagName).toBe("SELECT");
    expect(box.value).toBe("2009");
    expect([...box.querySelectorAll("optgroup")].map((g) => g.label)).toEqual([
      "Dairy & eggs", "Bakery", "Grocery & staples", "Beverages",
      "Snacks & confectionery", "Packaging", "Cleaning & disposables",
    ]);
    ui.unmount();
  });

  it("says what a picked code implies but never writes it into a box this desk cannot save", () => {
    as("store");                                        // owns the HSN; the GST rate is the manager's
    const ui = openItem("juice");
    expect(ui.field<HTMLInputElement>("GST %").value).toBe("12");
    act(() => { pick(ui.field<HTMLSelectElement>("HSN"), "2202"); });
    expect(ui.field<HTMLInputElement>("GST %").value).toBe("12");
    expect(ui.text()).toContain("2202 is offered at 28% GST - the outlet manager sets the rate.");
    ui.unmount();
  });

  it("opens on the text box for a code the curated list does not carry", () => {
    as("store");
    const ui = openItem("chips");                       // HSN 2005, not one of the offered codes
    const box = ui.field<HTMLInputElement>("HSN");
    expect(box.tagName).toBe("INPUT");
    expect(box.value).toBe("2005");
    ui.unmount();
  });

  it("greys the picker out for the manager, who owns the rate and not the code", () => {
    as("manager");
    const ui = openItem("juice");
    expect(ui.field<HTMLSelectElement>("HSN").disabled).toBe(true);
    expect(ui.field<HTMLInputElement>("GST %").disabled).toBe(false);
    // Nothing to tell the manager about a slab they set themselves.
    expect(ui.text()).not.toContain("the outlet manager sets the rate");
    ui.unmount();
  });
});

describe("the printed MRP on the prices screen", () => {
  beforeEach(() => {
    as("manager");
    useApp.setState({ shopFilter: "coffee" });
  });

  it("has a column of its own, and a dash for an item that carries none", () => {
    const ui = mount(Prices);
    const heads = [...ui.host.querySelectorAll("thead th")].map((h) => h.textContent ?? "");
    expect(heads.some((h) => h.startsWith("MRP"))).toBe(true);
    const row = (n: string) => [...ui.host.querySelectorAll("tbody tr")]
      .find((r) => r.textContent?.includes(n))!;
    expect(row("Real Juice 200ml").textContent).toContain("₹20.00");   // its printed MRP
    expect(row("Cappuccino").textContent).toContain("—");              // made to order, no pack
    ui.unmount();
  });

  it("says on the page what the till will charge once the typed price is over the MRP", () => {
    const ui = mount(Prices);
    const box = ui.host.querySelector<HTMLInputElement>('input[aria-label="New price for Real Juice 200ml"]')!;
    expect(ui.text()).not.toContain("Till charges");
    act(() => { typeIn(box, "25"); });
    expect(ui.text()).toContain("Till charges ₹20.00 (MRP)");
    expect(ui.text()).not.toContain("will be refused");
    // Back under the MRP and the note goes with it.
    act(() => { typeIn(box, "19"); });
    expect(ui.text()).not.toContain("Till charges");
    ui.unmount();
  });
});

describe("a dashboard's alert stack", () => {
  /** A request this counter raised and the outlet manager turned down. */
  const turnedDown = (n: number): DatedDoc<StockRequest> => ({
    id: `REQ-2026-10${n}`, from: "coffee", by: "Kavitha Raman", at: "09:0" + n,
    iso: new Date(Date.now() - n * 1000).toISOString(),
    lines: [{ it: "juice", qty: 5, appr: 0 }], st: "Rejected", ticket: null,
    mgrNote: "Nothing left on the shelf",
    hist: [{ s: "Rejected", who: "Ramesh Kumar", t: "09:0" + n, iso: new Date().toISOString() }],
  });

  it("draws the first four and counts the rest, rather than running off the page", () => {
    as("counter");
    act(() => { useApp.setState({ req: [1, 2, 3, 4, 5, 6].map(turnedDown) }); });
    const ui = mount(CounterDashboard);
    const banners = ui.alerts();
    expect(banners.filter((t) => t.includes("was rejected by the outlet manager"))).toHaveLength(4);
    expect(banners.some((t) => t.includes("…and 2 more."))).toBe(true);
    // The KPI still counts every one of them - the cap is on what is drawn, never on what is read.
    expect(ui.kpi("Requests raised")).toBe("6");
    ui.unmount();
  });

  it("leaves a short list alone", () => {
    as("counter");
    act(() => { useApp.setState({ req: [1, 2].map(turnedDown) }); });
    const ui = mount(CounterDashboard);
    const banners = ui.alerts();
    expect(banners.filter((t) => t.includes("was rejected by the outlet manager"))).toHaveLength(2);
    expect(banners.some((t) => t.includes("more."))).toBe(false);
    ui.unmount();
  });
});

describe("a widget over an uncapped collection", () => {
  it("scrolls inside its card instead of stretching the page", () => {
    as("manager");
    const ui = mount(ManagerDashboard);
    const capped = [...ui.host.querySelectorAll(".card-b.scroll")];
    expect(capped.length).toBe(3);     // outlet summary, the approval queue, recent activity
    ui.unmount();
  });
});
