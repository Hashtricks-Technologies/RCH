import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { IT } from "../data/master";
import { useApp } from "../store";
import { cartOf } from "../store/till";
import { POS_CATEGORY_ORDER } from "../lib/selectors";
import Pos from "../roles/counter/Pos";
import { resetStore, S, as } from "./fixture";

/**
 * The category rail on the Point of Sale. The Coffee Shop's till is capp, chai, juice and water
 * (Beverage) and bisc and chips (Snacks).
 */

const KEY = "rch-pos-cat:coffee";

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(Pos))); });
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>(".poscats .poscat")];
  return {
    host,
    box: () => host.querySelector<HTMLInputElement>('input[aria-label="Search this till\'s products"]')!,
    rail: () => buttons().map((b) => `${b.children[0].textContent} ${b.children[1].textContent}`),
    on: () => buttons().filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.children[0].textContent),
    pick: (g: string) => { act(() => { buttons().find((b) => b.children[0].textContent === g)!.click(); }); },
    tiles: () => [...host.querySelectorAll(".tilegrid .tile")].map((t) => t.id.replace("pos-tile-", "")),
    text: () => host.textContent ?? "",
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}

beforeEach(() => {
  localStorage.clear();
  resetStore();
  as("counter");
});
afterEach(() => { document.body.innerHTML = ""; });

describe("the POS category rail", () => {
  it("lists All and each group on this till with its count, preferred names first", () => {
    const m = mount();
    expect(m.rail()).toEqual(["All 6", "Snacks 2", "Beverage 4"]);
    expect(m.on()).toEqual(["All"]);
    m.unmount();
  });

  it("orders the hospital's own names as listed, then any other group alphabetically", () => {
    expect(POS_CATEGORY_ORDER.indexOf("Snacks")).toBeLessThan(POS_CATEGORY_ORDER.indexOf("Juices"));
    IT.juice = { ...IT.juice, g: "Juices" };
    IT.bisc = { ...IT.bisc, g: "Biscuits" };
    IT.water = { ...IT.water, g: "Zeta" };
    IT.capp = { ...IT.capp, g: "Alpha" };
    const m = mount();
    expect(m.rail()).toEqual(["All 6", "Snacks 1", "Juices 1", "Biscuits 1", "Alpha 1", "Beverage 1", "Zeta 1"]);
    m.unmount();
  });

  it("never shows a group with nothing on this till", () => {
    const m = mount();
    for (const g of ["Meals", "Bakery", "Dairy", "Grocery", "Packaging", "Prepared"]) {
      expect(m.rail().some((r) => r.startsWith(g + " "))).toBe(false);
    }
    act(() => { useApp.setState({ menu: { ...S().menu, coffee: ["capp", "chai", "juice", "water"] } }); });
    expect(m.rail()).toEqual(["All 4", "Beverage 4"]);
    m.unmount();
  });

  it("shows only the picked category's tiles, and All brings every tile back", () => {
    const m = mount();
    m.pick("Snacks");
    expect(m.on()).toEqual(["Snacks"]);
    expect(m.tiles()).toEqual(["bisc", "chips"]);
    expect(m.text()).toContain("2 of 6");
    m.pick("All");
    expect(m.tiles()).toHaveLength(6);
    m.unmount();
  });

  it("searches within the category, names it, and show all widens the search", () => {
    const m = mount();
    m.pick("Beverage");
    type(m.box(), "chips");
    expect(m.tiles()).toEqual([]);
    expect(m.text()).toContain("No product on this till matches “chips” in Beverage");
    expect(m.text()).toContain("in Beverage · show all");
    act(() => { m.host.querySelector<HTMLButtonElement>(".poscat-wide")!.click(); });
    expect(m.on()).toEqual(["All"]);
    expect(m.tiles()).toEqual(["chips"]);
    expect(m.box().value).toBe("chips");
    expect(m.host.querySelector(".poscat-wide")).toBeNull();
    m.unmount();
  });

  it("adds a tapped tile to the bill on screen", () => {
    const m = mount();
    m.pick("Snacks");
    act(() => { m.host.querySelector<HTMLButtonElement>("#pos-tile-chips .tile-pic-hit")!.click(); });
    expect(cartOf(S(), "coffee")).toEqual({ chips: 1 });
    m.unmount();
  });

  it("remembers the last pick for this counter, and falls back to All when it has emptied", () => {
    const m = mount();
    m.pick("Snacks");
    expect(localStorage.getItem(KEY)).toBe("Snacks");
    m.unmount();
    const again = mount();
    expect(again.on()).toEqual(["Snacks"]);
    expect(again.tiles()).toEqual(["bisc", "chips"]);
    again.pick("All");
    expect(localStorage.getItem(KEY)).toBeNull();
    again.unmount();
    localStorage.setItem(KEY, "Meals");
    const gone = mount();
    expect(gone.on()).toEqual(["All"]);
    expect(gone.tiles()).toHaveLength(6);
    gone.unmount();
  });

  it("still works when storage throws", () => {
    const own = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
    try {
      const m = mount();
      expect(m.on()).toEqual(["All"]);
      m.pick("Snacks");
      expect(m.tiles()).toEqual(["bisc", "chips"]);
      m.unmount();
    } finally {
      if (own) Object.defineProperty(globalThis, "localStorage", own);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});
