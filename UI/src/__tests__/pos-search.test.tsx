import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { IT } from "../data/master";
import { useApp } from "../store";
import { activeBill, cartOf } from "../store/till";
import Pos from "../roles/counter/Pos";
import { resetStore, S, as } from "./fixture";

/**
 * The product search on the Point of Sale: what it finds, the group cut, and billing from the
 * keyboard. The Coffee Shop's till is capp, chai, juice, water, bisc and chips.
 */

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(Pos))); });
  const box = () => host.querySelector<HTMLInputElement>('input[aria-label="Search this till\'s products"]')!;
  return {
    host,
    box,
    text: () => host.textContent ?? "",
    tiles: () => [...host.querySelectorAll(".tilegrid .tile")].map((t) => t.id.replace("pos-tile-", "")),
    lit: () => host.querySelector(".tilegrid .tile.is-hi")?.id.replace("pos-tile-", "") ?? null,
    key: (k: string, target: Element = box()) => {
      act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
    },
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
function pick(el: HTMLSelectElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => { set.call(el, value); el.dispatchEvent(new Event("change", { bubbles: true })); });
}

beforeEach(() => {
  resetStore();
  as("counter");
  IT.chips = { ...IT.chips, dn: "Masala Tapioca Chips" };
});
afterEach(() => { document.body.innerHTML = ""; });

describe("the POS product search", () => {
  it("is focused as the screen opens and counts the whole till", () => {
    const m = mount();
    expect(document.activeElement).toBe(m.box());
    expect(m.tiles()).toHaveLength(6);
    expect(m.text()).toContain("6 of 6");
    m.unmount();
  });

  it("finds a product by its display name, its real name and its code, in any case", () => {
    const m = mount();
    type(m.box(), "TAPIOCA");
    expect(m.tiles()).toEqual(["chips"]);
    type(m.box(), "salted");
    expect(m.tiles()).toEqual(["chips"]);
    type(m.box(), "mt-500");
    expect(m.tiles()).toEqual(["capp", "chai"]);
    expect(m.text()).toContain("2 of 6");
    m.unmount();
  });

  it("matches every word typed, in any order", () => {
    const m = mount();
    type(m.box(), "chips tap");
    expect(m.tiles()).toEqual(["chips"]);
    type(m.box(), "masala");
    expect(m.tiles()).toEqual(["chai", "chips"]);
    type(m.box(), "tea masala");
    expect(m.tiles()).toEqual(["chai"]);
    m.unmount();
  });

  it("cuts by group, together with the text", () => {
    const m = mount();
    const group = m.host.querySelector<HTMLSelectElement>('select[aria-label="Group"]')!;
    expect([...group.options].map((o) => o.value)).toEqual(["All", "Beverage", "Snacks"]);
    pick(group, "Snacks");
    expect(m.tiles()).toEqual(["bisc", "chips"]);
    type(m.box(), "masala");
    expect(m.tiles()).toEqual(["chips"]);
    pick(group, "All");
    expect(m.tiles()).toEqual(["chai", "chips"]);
    m.unmount();
  });

  it("moves the highlight with the arrows and Enter adds it to the bill on screen, then clears the box", () => {
    S().newBill("coffee");
    const second = activeBill(S(), "coffee").id;
    const m = mount();
    type(m.box(), "mt-500");
    expect(m.lit()).toBe("capp");
    m.key("ArrowDown");
    expect(m.lit()).toBe("chai");
    m.key("ArrowDown");
    expect(m.lit()).toBe("capp");        // wraps round
    m.key("ArrowUp");
    expect(m.lit()).toBe("chai");
    m.key("Enter");
    expect(activeBill(S(), "coffee").id).toBe(second);
    expect(cartOf(S(), "coffee")).toEqual({ chai: 1 });
    expect(m.box().value).toBe("");
    expect(document.activeElement).toBe(m.box());
    expect(m.tiles()).toHaveLength(6);
    m.unmount();
  });

  it("will not add an unavailable product, and says why", () => {
    useApp.setState({ ovr: { "coffee:capp": "Machine down" } });
    const m = mount();
    type(m.box(), "cappuccino");
    expect(m.tiles()).toEqual(["capp"]);
    expect(m.text()).toContain("Machine down");
    m.key("Enter");
    expect(cartOf(S(), "coffee")).toEqual({});
    expect(S().toast).toContain("Cappuccino was not added to the bill - Machine down.");
    expect(m.box().value).toBe("cappuccino");
    m.unmount();
  });

  it("clears the box on Escape", () => {
    const m = mount();
    type(m.box(), "juice");
    expect(m.tiles()).toEqual(["juice"]);
    m.key("Escape");
    expect(m.box().value).toBe("");
    expect(m.tiles()).toHaveLength(6);
    m.unmount();
  });

  it("says so when nothing matches, and Clear brings the till back", () => {
    const m = mount();
    type(m.box(), "samosa");
    expect(m.tiles()).toEqual([]);
    expect(m.text()).toContain("No product on this till matches “samosa”");
    expect(m.text()).toContain("0 of 6");
    const clear = [...m.host.querySelectorAll(".empty button")].find((b) => b.textContent === "Clear")!;
    act(() => { (clear as HTMLButtonElement).click(); });
    expect(m.box().value).toBe("");
    expect(m.tiles()).toHaveLength(6);
    m.unmount();
  });

  it("jumps to the box on / from elsewhere, but not while typing in another field", () => {
    const m = mount();
    act(() => { m.box().blur(); });
    m.key("/", document.body);
    expect(document.activeElement).toBe(m.box());
    const name = m.host.querySelector<HTMLInputElement>('input[placeholder="Optional"]')!;
    act(() => { name.focus(); });
    m.key("/", name);
    expect(document.activeElement).toBe(name);
    m.unmount();
  });
});
