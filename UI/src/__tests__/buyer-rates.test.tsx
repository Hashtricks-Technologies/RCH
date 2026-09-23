import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import Drawer from "../ui/Drawer";
import ProcurementList from "../roles/buyer/ProcurementList";
import Contracts from "../roles/buyer/Contracts";
import "../roles/buyer/AddToListDrawer";           // registers "baddpool"
import "../roles/buyer/PoDrawer";                  // registers "bpo"
import { lastPurchase } from "../roles/buyer/lib";
import { applyContracts } from "../api/wire";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import { as, resetStore, S } from "./fixture";

/**
 * The buyer's prices: the Add items drawer that looked dead under a quantity typed last, the
 * rate a procurement-list row carries into its order, the draft order's last-purchased and
 * contract columns, and the trail a contract's rate leaves on Rate Contracts. The rules - which
 * contract moves, when - are the API's (`modules/purchaseorders`, `modules/contracts`).
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn();
const calls = () => fetchMock.mock.calls.map((c) => {
  const [u, init] = c as [string, RequestInit];
  return { at: `${init.method} ${String(u).split("?")[0]}`, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown };
});

const tick = () => act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });

let unmount: (() => void) | undefined;
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MemoryRouter, null, el)); });
  unmount = () => { act(() => { root.unmount(); }); host.remove(); };
  return host;
}
const button = (host: ParentNode, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === label)!;
const box = (host: ParentNode, label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

/** Typing into a box that keeps focus - nothing blurs it, exactly as a person still in the field. */
const type = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
/**
 * A mouse press on a button, the way a browser delivers it: `mousedown` first, then `click` -
 * which a disabled button never receives. jsdom moves no focus on a press, so nothing here blurs
 * the box the operator is standing in unless the screen does it itself.
 */
const press = async (b: HTMLButtonElement) => {
  await act(async () => { b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
  await act(async () => { b.click(); });
  await tick();
};

beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  act(() => { as("buyer"); setAccessToken("tok"); });
});
afterEach(() => { unmount?.(); unmount = undefined; vi.unstubAllGlobals(); setAccessToken(null); });

describe("Add items to the procurement list", () => {
  const open = async () => {
    const host = await mount(createElement(Drawer));
    act(() => { S().openDrawer("baddpool", "new"); });
    await act(async () => { button(host, "Add item").click(); });
    return host;
  };

  it("adds what was typed when the quantity is the last thing typed before the press", async () => {
    fetchMock.mockImplementation((u: string, init: RequestInit) => Promise.resolve(
      init.method === "POST" && String(u).endsWith("/requisitions/direct")
        ? json({ result: {}, changed: [], message: "PRQ-2026-017 added to the procurement list - 1 line(s)" })
        : json([]),
    ));
    const host = await open();
    await type(host.querySelector("textarea")!, "Festival week");
    const qty = host.querySelector<HTMLInputElement>('input[aria-label^="Quantity of"]')!;
    // An untouched line reads empty, not "0" somebody has to delete first.
    expect(qty.value).toBe("");
    await type(qty, "12");

    await press(button(host, "Add to procurement list"));

    const sent = calls().filter((c) => c.at === "POST /api/v1/requisitions/direct");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ lines: [{ it: expect.any(String), qty: 12 }], note: "Festival week" });
    expect(S().toast).toBe("PRQ-2026-017 added to the procurement list - 1 line(s)");
  });

  it("says what is missing rather than sitting there greyed out", async () => {
    const host = await open();
    const add = button(host, "Add to procurement list");
    expect(add.disabled).toBe(false);

    await press(add);
    expect(S().toast).toBe("Enter a quantity on at least one item before adding to the procurement list.");

    await type(host.querySelector<HTMLInputElement>('input[aria-label^="Quantity of"]')!, "3");
    await press(add);
    expect(S().toast).toBe("Give a reason for buying these items - the store keeper reads it on the requisition.");
    expect(calls().filter((c) => c.at.startsWith("POST"))).toHaveLength(0);
  });
});

describe("the rate on a procurement-list row", () => {
  it("starts at the vendor's contract rate, shows the last purchase, and raises the order at the rate typed", async () => {
    const createPo = vi.fn(async () => "PO-2026-0143");
    act(() => { useApp.setState({ createPo }); });
    const host = await mount(createElement(ProcurementList));

    const vendor = host.querySelector<HTMLSelectElement>('select[aria-label="Vendor for Maida"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(vendor, "VN-003");
      vendor.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // RC-105: Anandha's live maida contract at 42.
    expect(box(host, "Rate for Maida").value).toBe("42");
    // Milk was last bought on PO-2026-0142 at 54.
    const milkRow = box(host, "Rate for Milk 1L (toned)").closest("tr")!;
    expect(milkRow.textContent).toContain("₹54.00");
    expect(milkRow.textContent).toContain("PO-2026-0142");

    act(() => { box(host, "Select Maida").click(); });
    await type(box(host, "Rate for Maida"), "44.5");
    await press(button(host, "Raise purchase order"));

    expect(createPo).toHaveBeenCalledTimes(1);
    const [vendorId, picks] = createPo.mock.calls[0] as unknown as [string, { rate?: number }[]];
    expect(vendorId).toBe("VN-003");
    expect(picks.every((p) => p.rate === 44.5)).toBe(true);
  });

  it("refuses to raise with no vendor chosen, in words", async () => {
    const createPo = vi.fn(async () => "PO-2026-0143");
    act(() => { useApp.setState({ createPo, poolVendor: {} }); });
    const host = await mount(createElement(ProcurementList));
    const vendor = host.querySelector<HTMLSelectElement>('select[aria-label="Vendor for Maida"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(vendor, "");
      vendor.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => { box(host, "Select Maida").click(); });
    await press(button(host, "Raise purchase order"));
    expect(createPo).not.toHaveBeenCalled();
    expect(S().toast).toBe("Choose an active vendor for Maida before raising the order.");
  });
});

describe("a draft purchase order's rates", () => {
  it("sends only once the rate typed last has landed", async () => {
    const order: string[] = [];
    let land!: (ok: boolean) => void;
    const updatePoLine = vi.fn(() => new Promise<boolean>((r) => { land = (ok) => { order.push("rate"); r(ok); }; }));
    const sendPo = vi.fn(async () => { order.push("send"); return true; });
    act(() => { useApp.setState({ updatePoLine, sendPo }); });
    const host = await mount(createElement(Drawer));
    act(() => { S().openDrawer("bpo", "PO-2026-0140"); });

    await type(box(host, "Rate for Sugar, refined"), "47");
    const send = button(host, "Send to vendor");
    await act(async () => { send.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
    await act(async () => { send.click(); });
    expect(updatePoLine).toHaveBeenCalledWith("PO-2026-0140", 0, { rate: 47 });
    expect(sendPo).not.toHaveBeenCalled();
    await act(async () => { land(true); });
    await tick();
    expect(order).toEqual(["rate", "send"]);
  });

  it("does not send when the rate typed last was refused", async () => {
    const updatePoLine = vi.fn(async () => false);
    const sendPo = vi.fn(async () => true);
    act(() => { useApp.setState({ updatePoLine, sendPo }); });
    const host = await mount(createElement(Drawer));
    act(() => { S().openDrawer("bpo", "PO-2026-0140"); });
    await type(box(host, "Rate for Sugar, refined"), "47");
    await press(button(host, "Send to vendor"));
    expect(sendPo).not.toHaveBeenCalled();
    expect(S().toast).toBe("PO-2026-0140 was not sent - a change to one of its lines was refused. Check the lines, then send it again.");
    // Read once: the next press sends.
    await press(button(host, "Send to vendor"));
    expect(sendPo).toHaveBeenCalledWith("PO-2026-0140");
  });

  it("shows the last purchase and the contract rate it moved", async () => {
    act(() => {
      useApp.setState({
        contracts: S().contracts.map((c) => c.id !== "RC-106" ? c : {
          ...c, rate: 48,
          changes: [{ oldRate: 46, newRate: 48, po: "PO-2026-0140", by: "Latha Narayanan", at: "10:00", iso: new Date().toISOString() }],
        }),
      });
    });
    const host = await mount(createElement(Drawer));
    act(() => { S().openDrawer("bpo", "PO-2026-0140"); });
    const row = box(host, "Rate for Sugar, refined").closest("tr")!;
    expect(row.textContent).toContain("Contract RC-106 changed ₹46.00 → ₹48.00");
    expect(row.textContent).toContain("On contract");
  });
});

describe("a contract's rate history", () => {
  it("reads old → new, the difference, who, when and the order it came from", async () => {
    const at = "2026-09-20T04:30:00.000Z";
    act(() => {
      applyContracts([{
        id: "RC-101", vendor: "Aavin Dairy Depot", it: "milk", rate: 58, from: "2026-04-01", to: "2027-03-31", moq: 40, active: true,
        changes: [
          { oldRate: 50, newRate: 52, by: "Latha Narayanan", at: "2026-09-01T04:30:00.000Z" },
          { oldRate: 52, newRate: 58, po: "PO-2026-0150", by: "Latha Narayanan", at },
        ],
      }]);
    });
    expect(S().contracts[0]!.changes![1]).toMatchObject({ at: "10:00", iso: at });
    const host = await mount(createElement(Contracts));
    const text = host.textContent ?? "";
    expect(text).toContain("2 changes");
    expect(text).toContain("₹52.00 → ₹58.00");
    expect(text).toContain("+₹6.00 (11.5%)");
    expect(text).toContain("from PO-2026-0150");
    expect(text).toContain("on Rate Contracts");
  });

  it("says a contract never changed", async () => {
    const host = await mount(createElement(Contracts));
    expect(host.textContent).toContain("Never changed");
  });
});

describe("lastPurchase", () => {
  const po = (id: string, vendor: string, st: "Draft" | "Ordered" | "Cancelled" | "Received", iso: string, rate: number) =>
    ({ id, vendor, st, iso, lines: [{ it: "milk", qty: 1, rate, src: [], recv: 0, rejected: 0 }] });

  it("takes the latest order that went out, and narrows to one vendor on request", () => {
    const list = [
      po("PO-1", "VN-001", "Received", "2026-09-01T00:00:00Z", 50),
      po("PO-2", "VN-002", "Ordered", "2026-09-05T00:00:00Z", 53),
      po("PO-3", "VN-001", "Draft", "2026-09-09T00:00:00Z", 40),
      po("PO-4", "VN-001", "Cancelled", "2026-09-10T00:00:00Z", 39),
    ];
    expect(lastPurchase(list, "milk")).toMatchObject({ po: "PO-2", rate: 53 });
    expect(lastPurchase(list, "milk", "VN-001")).toMatchObject({ po: "PO-1", rate: 50 });
    expect(lastPurchase(list, "sugar")).toBeUndefined();
  });
});
