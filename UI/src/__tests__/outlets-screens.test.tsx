import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOC } from "../data/master";
import { useApp } from "../store";
import { screens as manager } from "../roles/manager";
import { screens as counter } from "../roles/counter";
import { as, resetStore } from "./fixture";

const JUICE = {
  n: "Juice Bar", c: "OT-JB", type: "Outlet" as const, floor: "Ground", cc: "CC-JB",
  list: "A" as const, active: true, par: 0.18,
};

beforeEach(resetStore);

/** Hosts that stay mounted for the length of a case - the same helper `screens.test.tsx`
 *  defines, copied here because it closes over its own `mounted` array and `afterEach`. */
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
      [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label))!,
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
  mounted.push(ui);
  return ui;
}

describe("an outlet opened after release", () => {
  it("is a column on the manager's availability board and an outlet a counter may ask", () => {
    LOC["juice-bar"] = JUICE;
    act(() => {
      as("manager");
      useApp.setState((s) => ({ stock: { ...s.stock, "juice-bar": {} }, menu: { ...s.menu, "juice-bar": [] } }));
    });
    expect(mount(manager.avail).text()).toContain("Juice Bar");

    act(() => { as("counter"); });                        // Kavitha, Coffee Shop
    const ui = mount(counter.requests);
    // The peer picker is only on the page once the "From other shops" card is opened.
    act(() => { ui.button("From other shops").click(); });
    expect(ui.text()).toContain("Juice Bar");
  });
});

describe("a closed outlet", () => {
  it("is offered nowhere new, but still filters the manager's approvals", () => {
    LOC.kiosk = { ...LOC.kiosk, active: false };
    act(() => { as("manager"); });
    expect(mount(manager.avail).text()).not.toContain("Snack Kiosk");
    expect(mount(manager.approvals).text()).toContain("Snack Kiosk (closed)");
  });
});
