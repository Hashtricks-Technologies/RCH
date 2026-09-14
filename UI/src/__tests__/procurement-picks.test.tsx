import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { useApp } from "../store";
import ProcurementList from "../roles/buyer/ProcurementList";
import type { DatedDoc, Requisition } from "../types";
import { as, resetStore, S } from "./fixture";

let host: HTMLDivElement;
let root: Root;

const mount = () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(ProcurementList))); });
};
const unmount = () => {
  act(() => { root.unmount(); });
  host.remove();
};

const vendorSelect = (name: string) =>
  host.querySelector<HTMLSelectElement>(`select[aria-label="Vendor for ${name}"]`)!;
const choose = (name: string, vendor: string) => {
  const el = vendorSelect(name);
  act(() => {
    // React tracks the value it last rendered, so set it through the native setter or the
    // change event is swallowed as a no-op.
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, vendor);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

/** A requisition landing on the list the way a refetch puts one there: approved, nothing ordered. */
const approved = (id: string, lines: { it: string; qty: number }[]): DatedDoc<Requisition> => {
  const iso = new Date().toISOString();
  return {
    id, by: "Suresh Muthu", at: "10:00", iso, st: "Approved", note: "",
    lines: lines.map((l) => ({ it: l.it, qty: l.qty, appr: l.qty, ordered: 0, short: 0 })),
    hist: [{ s: "Approved", who: "Latha Narayanan", t: "10:00", iso }],
  };
};

beforeEach(() => { resetStore(); as("buyer"); });
afterEach(() => { if (host?.isConnected) unmount(); });

describe("the vendor picked on a procurement-list row", () => {
  it("survives new items landing on the list", () => {
    mount();
    choose("Maida", "VN-005");
    expect(vendorSelect("Maida").value).toBe("VN-005");

    act(() => { useApp.setState({ prq: [...S().prq, approved("PRQ-2026-016", [{ it: "cup", qty: 500 }])] }); });

    expect(vendorSelect("Maida").value).toBe("VN-005");
  });

  it("survives leaving the screen and coming back", () => {
    mount();
    choose("Maida", "VN-005");
    unmount();

    mount();
    expect(vendorSelect("Maida").value).toBe("VN-005");
  });

  it("is forgotten once its item is ordered in full, and kept for what is still pending", async () => {
    mount();
    choose("Maida", "VN-005");
    choose("Milk 1L (toned)", "VN-002");
    // The server's side of the raise, as the refetch lands it: Maida's line is now claimed in full.
    act(() => {
      useApp.setState({
        createPo: async () => {
          useApp.setState({
            prq: S().prq.map((p) => p.id !== "PRQ-2026-014" ? p
              : { ...p, lines: p.lines.map((l) => l.it === "maida" ? { ...l, ordered: l.appr } : l) }),
          });
          return "PO-2026-0143";
        },
      });
    });

    act(() => { host.querySelector<HTMLInputElement>('input[aria-label="Select Maida"]')!.click(); });
    const raise = [...host.querySelectorAll("button")].find((b) => b.textContent === "Raise purchase order")!;
    await act(async () => { raise.click(); });

    expect(S().poolVendor).toEqual({ milk: "VN-002" });
  });

  it("a prune that drops nothing leaves the store as it was", () => {
    act(() => { S().setPoolVendor("maida", "VN-005"); });
    const before = S().poolVendor;
    act(() => { S().prunePoolVendors(["maida", "milk"]); });
    expect(S().poolVendor).toBe(before);
  });
});
