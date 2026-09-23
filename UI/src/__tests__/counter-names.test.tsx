import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { setAccessToken } from "../api/session";
import { IT } from "../data/master";
import { useApp } from "../store";
import Pos from "../roles/counter/Pos";
import CounterBills from "../roles/counter/Bills";
import ManagerBills from "../roles/manager/Bills";
import Drawer from "../ui/Drawer";
import "../roles/counter/BillDrawer";      // registers "cbill"
import "../roles/manager/ItemDrawer";      // registers "item"
import { resetStore, S, as } from "./fixture";

/**
 * The walk-in customer on a counter bill, and the display name the counters read: what the till
 * sends, what it keeps on a refusal, and which screens print which name. The rules themselves
 * (the phone's shape, who may set a display name) are the API's suites'.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (message: string) => json({ error: { code: "rule", message } }, 422);

const fetchMock = vi.fn();
function serve(stubs: Record<string, () => Response>): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make ? make() : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const bodiesOf = (at: string) => fetchMock.mock.calls
  .filter((c) => `${(c[1] as RequestInit).method} ${String(c[0]).split("?")[0]}` === at)
  .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);

function mount(node: Parameters<typeof createElement>[0]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(node))); });
  const input = (label: string) => {
    const l = [...host.querySelectorAll("label")].find((x) => x.textContent === label)!;
    return host.querySelector<HTMLInputElement>(`#${CSS.escape(l.htmlFor)}`)!;
  };
  return {
    host,
    text: () => host.textContent ?? "",
    input,
    button: (starts: string) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(starts)),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
const flush = async () => { for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); }); };

const BILL = {
  no: "CF/1188", loc: "coffee", opr: "Kavitha Raman", oprCol: "#0EA5E9", tot: 20, tax: 2.14,
  t: new Date().toISOString(), pay: "Cash", lines: [{ it: "juice", qty: 1, rate: 20 }],
  customerName: "Anitha S", customerPhone: "9843022118",
};

beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setAccessToken("tok");
  IT.juice = { ...IT.juice, dn: "Juice-20" };
});
afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); });

describe("the customer on a counter bill", () => {
  it("sends the name and phone typed, and nothing for boxes left blank", async () => {
    as("counter");
    serve({ "POST /api/v1/bills": () => json({ result: BILL, changed: [], message: "Bill CF/1188 · ₹20.00 collected at Coffee Shop" }) });
    S().addToCart("coffee", "juice", 1);
    expect(await S().pay("coffee", "Cash", undefined, { name: " Anitha S ", phone: "98430 22118" })).toBe("CF/1188");
    S().addToCart("coffee", "juice", 1);
    await S().pay("coffee", "Cash", undefined, { name: "  ", phone: "" });
    const [typed, blank] = bodiesOf("POST /api/v1/bills");
    expect(typed).toMatchObject({ customerName: "Anitha S", customerPhone: "98430 22118" });
    expect(blank).not.toHaveProperty("customerName");
    expect(blank).not.toHaveProperty("customerPhone");
  });

  it("keeps both boxes on a refusal and clears them once the bill is numbered", async () => {
    as("counter");
    S().addToCart("coffee", "juice", 1);
    let refuse = true;
    serve({
      "POST /api/v1/bills": () => (refuse
        ? refusal("12345 is not a phone number - give the customer's 10 digits, with or without +91")
        : json({ result: BILL, changed: [], message: "Bill CF/1188 · ₹20.00 collected at Coffee Shop" })),
    });
    const ui = mount(Pos);
    type(ui.input("Customer name"), "Anitha S");
    type(ui.input("Phone"), "12345");
    expect(ui.text()).toContain("Not a phone number yet - ten digits");

    await act(async () => { ui.button("Pay")!.click(); });
    await flush();
    expect(S().toast).toBe("12345 is not a phone number - give the customer's 10 digits, with or without +91");
    expect(ui.input("Customer name").value).toBe("Anitha S");
    expect(ui.input("Phone").value).toBe("12345");

    refuse = false;
    type(ui.input("Phone"), "+91 98430 22118");
    expect(ui.text()).not.toContain("Not a phone number yet");
    await act(async () => { ui.button("Pay")!.click(); });
    await flush();
    expect(ui.input("Customer name").value).toBe("");
    expect(ui.input("Phone").value).toBe("");
    ui.unmount();
  });

  it("finds a bill by the customer's name or phone on both Bills screens", () => {
    const other = { ...BILL, no: "CF/1189", customerName: undefined, customerPhone: undefined };
    useApp.setState({ bills: [BILL, other].map((b) => ({ ...b, t: "10:00", iso: new Date().toISOString() })) as never });
    for (const [role, screen] of [["counter", CounterBills], ["manager", ManagerBills]] as const) {
      as(role);
      for (const q of ["anitha", "98430 22118"]) {
        const ui = mount(screen);
        const search = ui.host.querySelector<HTMLInputElement>('input[type="search"], .toolbar input, input')!;
        type(search, q);
        expect(ui.text(), `${role} ${q}`).toContain("CF/1188");
        expect(ui.text(), `${role} ${q}`).not.toContain("CF/1189");
        ui.unmount();
      }
    }
  });
});

describe("the display name", () => {
  it("is what the till's tiles and cart read, and the real name is not", () => {
    as("counter");
    S().addToCart("coffee", "juice", 1);
    const ui = mount(Pos);
    expect(ui.host.querySelector('[aria-label="Add Juice-20"]')).not.toBeNull();
    expect(ui.host.querySelector('[aria-label="Juice-20 quantity"]')).not.toBeNull();
    expect(ui.text()).not.toContain("Real Juice 200ml");
    ui.unmount();
  });

  it("shows on the counter's bill drawer, while the manager's drawer and the paper keep the real name", () => {
    useApp.setState({ bills: [{ ...BILL, t: "10:00", iso: new Date().toISOString() }] as never });
    as("counter");
    useApp.setState({ drawer: { t: "cbill", id: "CF/1188" } });
    const counter = mount(Drawer);
    const slip = () => counter.host.querySelector(".print-slip")!.textContent ?? "";
    const screen = () => (counter.host.querySelector(".tbl, table")?.textContent ?? "");
    expect(screen()).toContain("Juice-20");
    expect(slip()).toContain("Real Juice 200ml");
    expect(slip()).not.toContain("Juice-20");
    expect(slip()).toContain("Customer Anitha S · 9843022118");
    expect(counter.text()).toContain("9843022118");
    counter.unmount();

    as("manager");
    useApp.setState({ drawer: { t: "cbill", id: "CF/1188" } });
    const manager = mount(Drawer);
    expect(manager.text()).not.toContain("Juice-20");
    manager.unmount();
  });

  it("is the manager's to set in the item drawer, and a blank clears it", async () => {
    as("manager");
    serve({ "PATCH /api/v1/items/juice": () => json({ result: { key: "juice", item: IT.juice }, changed: [], message: "Real Juice 200ml updated" }) });
    useApp.setState({ drawer: { t: "item", id: "juice" } });
    const ui = mount(Drawer);
    expect(ui.input("Display name").disabled).toBe(false);
    type(ui.input("Display name"), "  ");
    await act(async () => { ui.button("Save changes")!.click(); });
    await flush();
    expect(bodiesOf("PATCH /api/v1/items/juice")).toEqual([{ dn: "" }]);
    ui.unmount();

    as("store");
    useApp.setState({ drawer: { t: "item", id: "juice" } });
    const store = mount(Drawer);
    expect(store.input("Display name").disabled).toBe(true);
    store.unmount();
  });
});
