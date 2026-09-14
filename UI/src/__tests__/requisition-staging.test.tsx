import { beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import StoreStock from "../roles/store/Stock";
import StoreRequisitions from "../roles/store/Requisitions";
import BuyerRequisitions from "../roles/buyer/Requisitions";
import { useApp } from "../store";
import { as, resetStore, S } from "./fixture";

/**
 * Staging an item on the store keeper's requisition from Stock in Hand puts no quantity on it —
 * the keeper types what they want — and the buyer's "Waiting on you" queue carries no search or
 * filter of its own.
 */

beforeEach(resetStore);

function mount(node: Parameters<typeof createElement>[0]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(node))); });
  return { host, unmount: () => { act(() => { root.unmount(); }); host.remove(); } };
}

/** Milk is the seeded central store line below its reorder level, so its row offers the button. */
const addMilk = (host: HTMLElement) => {
  const row = [...host.querySelectorAll("tr")].find((r) => r.textContent?.includes("RM-1001"))!;
  const btn = [...row.querySelectorAll("button")].find((b) => b.textContent?.includes("Add to requisition"))!;
  act(() => { btn.click(); });
};

describe("Add to requisition on Stock in Hand", () => {
  it("stages the item with no quantity, and the requisition's box is empty rather than 0", () => {
    as("store");
    const stock = mount(StoreStock);
    addMilk(stock.host);
    stock.unmount();
    expect(S().prqDraft).toEqual([{ it: "milk", qty: 0 }]);

    const req = mount(StoreRequisitions);
    const box = req.host.querySelector<HTMLInputElement>("input[aria-label^='Quantity of']")!;
    expect(box.value).toBe("");
    req.unmount();
  });

  it("leaves a quantity the keeper already typed alone", () => {
    as("store");
    act(() => { useApp.setState({ prqDraft: [{ it: "milk", qty: 25 }] }); });
    const stock = mount(StoreStock);
    addMilk(stock.host);
    stock.unmount();
    expect(S().prqDraft).toEqual([{ it: "milk", qty: 25 }]);
  });
});

describe("the buyer's Waiting on you queue", () => {
  it("has no search box or filter", () => {
    as("buyer");
    const ui = mount(BuyerRequisitions);
    const waiting = [...ui.host.querySelectorAll(".card")].find((c) => c.textContent?.startsWith("Waiting on you"))!;
    expect(waiting).toBeDefined();
    expect(waiting.querySelector(".tbar")).toBeNull();
    expect(waiting.querySelector("select")).toBeNull();
    ui.unmount();
  });
});
