import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOC, hydrateLocations } from "../data/master";
import { money } from "../lib/fmt";
import { useApp } from "../store";
import { navFor } from "../nav";
import { as, deskScreens, resetStore, userOf } from "./fixture";

const manager = deskScreens("manager");

/**
 * The manager's counter price grid (`roles/manager/CounterPrices.tsx`): staged edits, the typed
 * CONFIRM before anything is sent, and the batch the store action receives. The rules - MRP,
 * a counter switched on with no price, copy-on-write between counters - are the API's suite's
 * (`modules/pricelists/pricelists.test.ts`); nothing here re-asserts one beyond its preview.
 */

beforeEach(resetStore);

const mounted: { unmount: () => void }[] = [];
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); });

function mount(C: ComponentType) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(C))); });
  const ui = {
    host,
    text: () => host.textContent ?? "",
    button: (label: string) =>
      [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label),
    price: (item: string, outlet: string) => host.querySelector<HTMLInputElement>(`input[aria-label="Price of ${item} at ${outlet}"]`)!,
    sw: (item: string, outlet: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Sell ${item} at ${outlet}"]`)!,
    headers: () => [...host.querySelectorAll("th")].map((th) => (th.textContent ?? "").trim()),
    rows: () => host.querySelectorAll("tbody tr").length,
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
  mounted.push(ui);
  return ui;
}
const typeIn = (el: HTMLInputElement, v: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const pick = (host: HTMLElement, label: string, v: string) => {
  const el = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  act(() => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); });
};
const settle = async (fn: () => void) => {
  await act(async () => { fn(); await new Promise((r) => { setTimeout(r, 0); }); });
};
const confirmBox = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[aria-label="Type CONFIRM to save"]')!;

describe("the manager's Prices entry", () => {
  it("is the counter grid, and the sidebar no longer offers price lists", () => {
    const labels = navFor(userOf("manager")).flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain("Prices");
    expect(labels).not.toContain("Price Lists");

    act(() => { as("manager"); });
    const ui = mount(manager.prices);
    expect(ui.text()).toContain("Counter prices");
    expect(ui.text()).not.toMatch(/price list|List A|List B/i);
  });
});

describe("the counter price grid", () => {
  it("puts every open outlet across the top and only sellable items down the side", () => {
    act(() => { as("manager"); });
    const ui = mount(manager.prices);
    for (const l of ["rest", "coffee", "kiosk"]) expect(ui.headers()).toContain(LOC[l].n);
    expect(ui.text()).toContain("Real Juice 200ml");
    expect(ui.text()).toContain("Cappuccino");
    expect(ui.text()).not.toContain("Milk 1L (toned)");
    expect(ui.text()).not.toContain("Paper cup 150ml");
    // Each counter reads its own price: the Coffee Shop's juice and the Restaurant's differ.
    expect(ui.price("Real Juice 200ml", "Coffee Shop").value).toBe("20");
    expect(ui.price("Real Juice 200ml", "Restaurant").value).toBe("18");
    expect(ui.sw("Real Juice 200ml", "Coffee Shop").getAttribute("aria-pressed")).toBe("true");
    expect(ui.sw("Veg sandwich", "Coffee Shop").getAttribute("aria-pressed")).toBe("false");
  });

  it("stages an edit, shows old → new, and saves only after CONFIRM is typed", async () => {
    const saveOutletPrices = vi.fn(async () => true);
    act(() => { as("manager"); useApp.setState({ saveOutletPrices }); });
    const ui = mount(manager.prices);

    typeIn(ui.price("Real Juice 200ml", "Coffee Shop"), "19");
    act(() => { ui.sw("Veg sandwich", "Coffee Shop").click(); });
    expect(ui.text()).toContain(`${money(20)} → ${money(19)}`);
    expect(ui.text()).toContain("Off → On");
    expect(ui.host.querySelectorAll(".cp-changed")).toHaveLength(2);

    await settle(() => { ui.button("Save 2 changes")!.click(); });
    expect(ui.text()).toContain("Type CONFIRM");
    const confirm = () => ui.button("Confirm")!;
    expect(confirm().disabled).toBe(true);
    typeIn(confirmBox(ui.host), "confirm");
    expect(confirm().disabled).toBe(true);
    typeIn(confirmBox(ui.host), "CONFIRM");
    expect(confirm().disabled).toBe(false);

    await settle(() => { confirm().click(); });
    expect(saveOutletPrices).toHaveBeenCalledWith([
      { loc: "coffee", it: "juice", price: 19 },
      { loc: "coffee", it: "sand", listed: true },
    ]);
    expect(ui.button("Save 2 changes")).toBeUndefined();
    expect(confirmBox(ui.host)).toBeNull();
  });

  it("keeps every staged edit on Cancel, and on a refusal", async () => {
    const saveOutletPrices = vi.fn(async () => false);
    act(() => { as("manager"); useApp.setState({ saveOutletPrices }); });
    const ui = mount(manager.prices);

    typeIn(ui.price("Masala tea", "Restaurant"), "22");
    await settle(() => { ui.button("Save 1 change")!.click(); });
    await settle(() => { ui.button("Cancel")!.click(); });
    expect(saveOutletPrices).not.toHaveBeenCalled();
    expect(ui.price("Masala tea", "Restaurant").value).toBe("22");

    await settle(() => { ui.button("Save 1 change")!.click(); });
    typeIn(confirmBox(ui.host), "CONFIRM");
    await settle(() => { ui.button("Confirm")!.click(); });
    expect(saveOutletPrices).toHaveBeenCalledTimes(1);
    expect(ui.price("Masala tea", "Restaurant").value).toBe("22");
    expect(ui.button("Save 1 change")).toBeDefined();

    act(() => { ui.button("Discard all")!.click(); });
    expect(ui.price("Masala tea", "Restaurant").value).toBe("20");
    expect(ui.button("Save 1 change")).toBeUndefined();
  });

  it("saves a price above the MRP, saying what the till will charge, but not a zero", () => {
    act(() => { as("manager"); });
    const ui = mount(manager.prices);

    typeIn(ui.price("Real Juice 200ml", "Snack Kiosk"), "25");
    expect(ui.text()).toContain(`Till charges ${money(20)} (MRP)`);
    expect(ui.text()).not.toContain("will be refused");
    expect(ui.button("Save 1 change")!.disabled).toBe(false);

    typeIn(ui.price("Real Juice 200ml", "Snack Kiosk"), "0");
    expect(ui.button("Save 1 change")!.disabled).toBe(true);
    expect(ui.text()).toContain("Enter a price greater than zero");
  });

  it("marks a counter with no price, and will not switch it on unpriced", () => {
    hydrateLocations({ ...LOC, kiosk: { ...LOC.kiosk, list: undefined } });
    act(() => { as("manager"); useApp.setState((s) => ({ catalogVersion: s.catalogVersion + 1 })); });
    const ui = mount(manager.prices);

    expect(ui.price("Veg sandwich", "Snack Kiosk").value).toBe("");
    expect(ui.price("Veg sandwich", "Snack Kiosk").closest(".cp-unpriced")).not.toBeNull();
    act(() => { ui.sw("Veg sandwich", "Snack Kiosk").click(); });
    expect(ui.text()).toContain("Needs a price before it can be sold here");
    expect(ui.button("Save 1 change")!.disabled).toBe(true);

    pick(ui.host, "Show", "Not priced");
    expect(ui.rows()).toBeGreaterThan(0);
    pick(ui.host, "Show", "Changed");
    expect(ui.rows()).toBe(1);
  });

  it("filters by search, type, group and counter", () => {
    act(() => { as("manager"); });
    const ui = mount(manager.prices);

    const search = ui.host.querySelector<HTMLInputElement>(".sfield input")!;
    typeIn(search, "chips");
    expect(ui.rows()).toBe(1);
    typeIn(search, "");

    pick(ui.host, "Type", "MTO");
    expect(ui.text()).toContain("Cappuccino");
    expect(ui.text()).not.toContain("Real Juice 200ml");
    pick(ui.host, "Type", "All");

    pick(ui.host, "Group", "Snacks");
    expect(ui.text()).toContain("Salted chips 52g");
    expect(ui.text()).not.toContain("Cappuccino");
    pick(ui.host, "Group", "All");

    pick(ui.host, "Counter", "Coffee Shop");
    expect(ui.headers()).toContain("Coffee Shop");
    expect(ui.headers()).not.toContain("Restaurant");

    typeIn(search, "no such thing");
    expect(ui.text()).toContain("Nothing matches those filters");
  });

  it("sorts on a header", () => {
    act(() => { as("manager"); });
    const ui = mount(manager.prices);
    const first = () => (ui.host.querySelector("tbody tr td")?.textContent ?? "");
    const byName = first();
    for (const h of ["Type", "Group", "Cost", "MRP"]) {
      const btn = [...ui.host.querySelectorAll("th button")].find((b) => (b.textContent ?? "").startsWith(h)) as HTMLButtonElement;
      act(() => { btn.click(); });
    }
    act(() => { ([...ui.host.querySelectorAll("th button")].find((b) => (b.textContent ?? "").startsWith("Item")) as HTMLButtonElement).click(); });
    expect(first()).toBe(byName);
  });
});
