import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, Fragment, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { refetch } from "../api/refetch";
import { setAccessToken } from "../api/session";
import { availOf } from "../lib/selectors";
import { useApp } from "../store";
import Drawer from "../ui/Drawer";
import KitchenStock from "../roles/prod/Stock";
import KitchenAvailability from "../roles/prod/Availability";
import Pos from "../roles/counter/Pos";
import "../roles/manager/ItemDrawer";   // registers "item"
import type { KitchenReport } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * The kitchen's two changes, from the browser: raw materials and packaging are issued and used,
 * never held (the Kitchen Stock screen reads what was issued and what was wasted instead of a
 * shelf), and a finished good is counted or on/off only (the new-product form, the item drawer,
 * the kitchen's switch reaching every till). The rules are the server's -
 * `apps/api/src/modules/wastage/wastage.test.ts` and `modules/catalog/onoff.test.ts`.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (message: string, status = 422) => json({ error: { code: "rule", message } }, status);

const fetchMock = vi.fn();
type Stubs = Record<string, () => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make ? make() : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const calls = () => fetchMock.mock.calls.map((c) => {
  const [u, init] = c as [string, RequestInit];
  return { at: `${init.method} ${String(u).split("?")[0]}`, url: String(u), body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown) };
});
const hit = (at: string) => calls().filter((c) => c.at === at);

let unmount: (() => void) | undefined;
function mount(el: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, el)); });
  unmount = () => { act(() => { root.unmount(); }); host.remove(); };
  return host;
}
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
const press = async (b: HTMLButtonElement | undefined) => {
  expect(b, "no such button").toBeTruthy();
  await act(async () => { b!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
  await act(async () => { b!.click(); });
  await settle();
};
const typeInto = async (el: HTMLInputElement, v: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const blur = async (el: HTMLInputElement) => { await act(async () => { el.dispatchEvent(new Event("focusout", { bubbles: true })); el.blur(); }); };
const pick = async (el: HTMLSelectElement, v: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const REPORT: KitchenReport = {
  from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString(),
  issued: [{ it: "maida", qty: 6, value: 252 }, { it: "cup", qty: 100, value: 62 }],
  wastage: [{ id: "WST-2026-0001", it: "maida", qty: 1, reason: "wastage", note: "Spilled", cost: 42, value: 42, by: "Vinoth Prakash", at: new Date().toISOString() }],
};

beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setAccessToken("tok");
});
afterEach(() => { unmount?.(); unmount = undefined; vi.unstubAllGlobals(); setAccessToken(null); });

describe("the kitchen slice on the wire", () => {
  it("reads the report for a window, and marks a failed read rather than showing nothing issued", async () => {
    as("prod");
    serve({ "GET /api/v1/reports/kitchen": () => json(REPORT) });
    expect(await S().loadKitchenReport(7)).toBe(true);
    expect(calls()[0]!.url).toContain("days=7");
    expect(S().kitchenReport?.issued).toHaveLength(2);
    expect(S().kitchenDays).toBe(7);
    serve({});
    expect(await S().loadKitchenReport()).toBe(false);
    expect(S().kitchenReportFailed).toBe(true);
    expect(calls().at(-1)!.url).toContain("days=7");
  });

  it("records wastage with the server's sentence and reads the report back; a refusal is toasted as sent", async () => {
    as("prod");
    serve({
      "POST /api/v1/wastage": () => json({ result: REPORT.wastage[0], changed: ["wastage"], message: "WST-2026-0001 - 1.000 kg of Maida recorded as wasted (wastage), ₹42.00 at cost" }),
      "GET /api/v1/reports/kitchen": () => json(REPORT),
    });
    expect(await S().recordWastage({ it: "maida", qty: 1, reason: "wastage", note: " Spilled " })).toBe(true);
    expect(hit("POST /api/v1/wastage")[0]!.body).toEqual({ it: "maida", qty: 1, reason: "wastage", note: "Spilled" });
    expect(S().toast).toBe("WST-2026-0001 - 1.000 kg of Maida recorded as wasted (wastage), ₹42.00 at cost");
    expect(hit("GET /api/v1/reports/kitchen")).toHaveLength(1);

    serve({ "POST /api/v1/wastage": () => refusal("Say what happened when the reason is Other") });
    expect(await S().recordWastage({ it: "maida", qty: 1, reason: "other", note: "" })).toBe(false);
    expect(S().toast).toBe("Say what happened when the reason is Other");
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await S().recordWastage({ it: "maida", qty: 1, reason: "wastage", note: "" })).toBe(false);
    expect(S().toast).toBe("Could not record the wastage - check the connection and try again.");
  });

  it("a wastage notice reads the report again for the kitchen alone", async () => {
    as("store");
    await refetch(["wastage"]);
    expect(fetchMock).not.toHaveBeenCalled();
    as("prod");
    serve({ "GET /api/v1/reports/kitchen": () => json(REPORT) });
    await refetch(["wastage"]);
    expect(hit("GET /api/v1/reports/kitchen")).toHaveLength(1);
  });
});

describe("Kitchen Stock", () => {
  it("shows what was issued and wasted instead of a raw shelf, with no par or low alert", async () => {
    as("prod");
    serve({ "GET /api/v1/reports/kitchen": () => json(REPORT) });
    const host = mount(createElement(KitchenStock));
    await settle();
    const text = host.textContent ?? "";
    expect(text).toContain("Issued to the kitchen");
    expect(text).toContain("₹252.00");
    expect(text).toContain("WST-2026-0001");
    expect(text).not.toContain("under the kitchen par");
    expect(text).not.toContain("LOW");
    expect(hit("GET /api/v1/reports/kitchen")[0]!.url).toContain("days=1");

    // Another window reads again.
    const period = [...host.querySelectorAll("select")].find((sel) => [...sel.options].some((o) => o.value === "Last 7 days"))!;
    await pick(period, "Last 7 days");
    await settle();
    expect(hit("GET /api/v1/reports/kitchen").some((c) => c.url.includes("days=7"))).toBe(true);
  });

  it("says the report could not be read, rather than that nothing was issued", async () => {
    as("prod");
    serve({});
    const host = mount(createElement(KitchenStock));
    await settle();
    expect(host.textContent).toContain("could not be read just now");
  });

  it("asks the store for an item straight from its row", async () => {
    as("prod");
    serve({
      "GET /api/v1/reports/kitchen": () => json(REPORT),
      "POST /api/v1/requests": () => json({ result: {}, changed: [], message: "REQ-2026-0913 sent to the outlet manager" }),
    });
    const host = mount(createElement(KitchenStock));
    await settle();
    await typeInto(host.querySelector<HTMLInputElement>('input[aria-label="Quantity of Maida to request"]')!, "4");
    const row = host.querySelector<HTMLInputElement>('input[aria-label="Quantity of Maida to request"]')!.closest("tr")!;
    await press(button(row as HTMLElement, "Request"));
    expect(hit("POST /api/v1/requests")[0]!.body).toMatchObject({ lines: [{ it: "maida", qty: 4 }] });
  });

  it("records wastage from its drawer, previewing the value at cost", async () => {
    as("prod");
    serve({
      "GET /api/v1/reports/kitchen": () => json(REPORT),
      "POST /api/v1/wastage": () => json({ result: REPORT.wastage[0], changed: ["wastage"], message: "WST-2026-0002 recorded" }),
    });
    const host = mount(createElement(Fragment, null, createElement(Drawer)));
    act(() => { S().openDrawer("kwaste", "new"); });
    await settle();
    await pick(host.querySelector<HTMLSelectElement>("select")!, "maida");
    const q = host.querySelector<HTMLInputElement>('input[aria-label="Quantity wasted"]')!;
    await typeInto(q, "2.5");
    await blur(q);
    expect(host.textContent).toContain("₹105.00 at cost");
    await press(button(host, "Record wastage"));
    expect(hit("POST /api/v1/wastage")[0]!.body).toEqual({ it: "maida", qty: 2.5, reason: "wastage", note: "" });
    expect(S().drawer).toBeNull();
  });
});

describe("the kitchen's new product: counted or on/off only", () => {
  const open = async () => {
    const host = mount(createElement(Drawer));
    act(() => { S().openDrawer("pnew", "new"); });
    await settle();
    await typeInto(host.querySelector<HTMLInputElement>('input[placeholder="Cold coffee premix 1kg"]')!, "Masala dosa");
    await typeInto([...host.querySelectorAll<HTMLInputElement>("input")].find((i) => i.placeholder === "0.00")!, "30");
    return host;
  };

  it("an on/off-only product asks whether it is available now, and sends no opening", async () => {
    as("prod");
    serve({ "POST /api/v1/items": () => json({ result: { key: "masaladosa", item: {} }, changed: ["items"], message: "Masala dosa added" }), "GET /api/v1/items": () => json({}) });
    const host = await open();
    await press(button(host, "On/off only"));
    expect(host.textContent).not.toContain("How many made now");
    expect(host.textContent).not.toContain("Shelf life");
    expect(host.textContent).toContain("Available now?");
    await press(host.querySelector<HTMLButtonElement>('button[aria-label="Available now"]')!);
    await press(button(host, "Add to the catalogue"));
    expect(hit("POST /api/v1/items")[0]!.body).toMatchObject({ name: "Masala dosa", type: "MTO", loc: "kitchen", opening: 0, avail: false });
  });

  it("a counted product asks how many were made now", async () => {
    as("prod");
    serve({ "POST /api/v1/items": () => json({ result: { key: "masaladosa", item: {} }, changed: ["items"], message: "added" }), "GET /api/v1/items": () => json({}) });
    const host = await open();
    expect(button(host, "Counted")?.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("How many made now");
    const made = [...host.querySelectorAll<HTMLInputElement>('input[placeholder="0"]')].at(-1)!;
    await typeInto(made, "12");
    await press(button(host, "Add to the catalogue"));
    const body = hit("POST /api/v1/items")[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ type: "FG", opening: 12 });
    expect(body).not.toHaveProperty("avail");
  });
});

describe("Counted / On/off only on the item drawer", () => {
  it("the kitchen moves a counted good to on/off only, and the patch sends that alone", async () => {
    as("prod");
    serve({ "PATCH /api/v1/items/puff": () => json({ result: { key: "puff", item: {} }, changed: [], message: "Veg puffs is now on/off only" }) });
    const host = mount(createElement(Drawer));
    act(() => { S().openDrawer("item", "puff"); });
    await settle();
    expect(host.textContent).toContain("Counted or on/off only");
    await press(button(host, "On/off only"));
    await press(button(host, "Save changes"));
    expect(hit("PATCH /api/v1/items/puff")[0]!.body).toEqual({ onOff: true });
  });

  it("is shut for a desk that is not the kitchen, and absent for what the kitchen does not make", async () => {
    as("store");
    const host = mount(createElement(Drawer));
    act(() => { S().openDrawer("item", "meals"); });
    await settle();
    expect(button(host, "Counted")?.disabled).toBe(true);
    expect(button(host, "On/off only")?.getAttribute("aria-pressed")).toBe("true");
    act(() => { S().openDrawer("item", "capp"); });
    await settle();
    expect(host.textContent).not.toContain("Counted or on/off only");
  });
});

describe("the kitchen's switch on an on/off-only product", () => {
  it("previews the till's refusal: off at every outlet, in the kitchen's words", () => {
    as("counter");
    const ovr = { "kitchen:meals": "switched off manually" };
    expect(availOf({ stock: S().stock, rsv: S().rsv, ovr }, "rest", "meals")).toEqual({ ok: false, mode: "Manual", why: "switched off by the kitchen" });
    expect(availOf({ stock: S().stock, rsv: S().rsv, ovr: {} }, "rest", "meals")).toEqual({ ok: true, mode: "Manual" });
  });

  it("the till shows the tile off with the kitchen's reason", async () => {
    as("counter");
    // The Coffee Shop lists meals in this case; the kitchen has switched them off.
    act(() => { useApp.setState({ menu: { ...S().menu, coffee: [...(S().menu.coffee ?? []), "meals"] }, ovr: { "kitchen:meals": "switched off manually" }, prices: { ...S().prices, "PL-002": { ...S().prices["PL-002"], meals: 95 } } }); });
    const host = mount(createElement(Pos));
    await settle();
    expect(host.querySelector('[aria-label="Veg meals - switched off by the kitchen"]')).toBeTruthy();
  });

  it("the kitchen's board lists it as on/off only, uncounted, with the outlets that list it", async () => {
    as("prod");
    const host = mount(createElement(KitchenAvailability));
    await settle();
    const row = [...host.querySelectorAll("tr")].find((r) => r.textContent?.includes("Veg meals"))!;
    expect(row.textContent).toContain("On/off only");
    expect(row.textContent).toContain("not counted");
    expect(row.textContent).toContain("Restaurant");
  });
});
