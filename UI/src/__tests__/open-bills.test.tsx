import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { setAccessToken } from "../api/session";
import { activeBill, cartOf, MAX_OPEN_BILLS, tillOf, tooManyBillsMessage } from "../store/till";
import Pos from "../roles/counter/Pos";
import { resetStore, S, as } from "./fixture";

/**
 * The till's open bills: a counter builds up to MAX_OPEN_BILLS at once, each with its own lines,
 * tender, payer and customer, and paying one takes exactly that one off the till. None of it is
 * on the server until a bill is paid, so what is pinned here is the browser's side alone.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (message: string) => json({ error: { code: "rule", message } }, 422);

const fetchMock = vi.fn();
function serve(stubs: Record<string, () => Response | Promise<Response>>): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make ? make() : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const bodiesOf = (at: string) => fetchMock.mock.calls
  .filter((c) => `${(c[1] as RequestInit).method} ${String(c[0]).split("?")[0]}` === at)
  .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>);

const BILL = {
  no: "CF/1188", loc: "coffee", opr: "Kavitha Raman", oprCol: "#0EA5E9", tot: 20, tax: 2.14,
  t: new Date().toISOString(), pay: "Cash", lines: [{ it: "juice", qty: 1, rate: 20 }],
};
const paid = () => json({ result: BILL, changed: [], message: "Bill CF/1188 · ₹20.00 collected at Coffee Shop" });

const bills = () => tillOf(S(), "coffee").bills;
const ns = () => bills().map((b) => b.n);

beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setAccessToken("tok");
  as("counter");
});
afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); });

describe("the till's open bills", () => {
  it("starts on one empty bill and holds at most ten", () => {
    expect(ns()).toEqual([1]);
    for (let i = 1; i < MAX_OPEN_BILLS; i += 1) expect(S().newBill("coffee")).toBe(true);
    expect(ns()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(activeBill(S(), "coffee").n).toBe(10);             // a new bill comes up on screen

    expect(S().newBill("coffee")).toBe(false);
    expect(S().toast).toBe(tooManyBillsMessage());
    expect(bills()).toHaveLength(MAX_OPEN_BILLS);
  });

  it("keeps each bill's lines, tender, payer and customer apart", () => {
    S().addToCart("coffee", "juice", 2);
    S().setBill("coffee", { custName: "Anitha S" });
    const first = activeBill(S(), "coffee").id;

    S().newBill("coffee");
    S().addToCart("coffee", "capp", 1);
    S().setBill("coffee", { tender: "Staff credit", payer: { kind: "staff", id: "RC-3120", name: "Ramesh Kumar" } });
    expect(cartOf(S(), "coffee")).toEqual({ capp: 1 });

    S().switchBill("coffee", first);
    expect(cartOf(S(), "coffee")).toEqual({ juice: 2 });
    expect(activeBill(S(), "coffee")).toMatchObject({ tender: "Cash", payer: null, custName: "Anitha S" });
    expect(bills()[1]).toMatchObject({ tender: "Staff credit", lines: { capp: 1 } });
  });

  it("gives a new bill the lowest number no open bill is using", () => {
    S().newBill("coffee");
    S().newBill("coffee");
    S().discardBill("coffee", bills()[1].id);
    expect(ns()).toEqual([1, 3]);
    S().newBill("coffee");
    expect(ns()).toEqual([1, 3, 2]);
  });

  it("brings up the bill before the one discarded, and never leaves the till empty", () => {
    S().addToCart("coffee", "juice", 1);
    S().newBill("coffee");
    S().newBill("coffee");
    const [one, two, three] = bills();
    S().switchBill("coffee", two.id);
    S().discardBill("coffee", two.id);
    expect(activeBill(S(), "coffee").id).toBe(one.id);

    S().discardBill("coffee", three.id);                     // not on screen: the screen stays put
    expect(activeBill(S(), "coffee").id).toBe(one.id);

    S().discardBill("coffee", one.id);
    expect(bills()).toHaveLength(1);
    expect(cartOf(S(), "coffee")).toEqual({});
    expect(ns()).toEqual([1]);
  });

  it("pays the bill on screen and takes only that one off the till", async () => {
    serve({ "POST /api/v1/bills": paid });
    S().addToCart("coffee", "juice", 2);
    const held = activeBill(S(), "coffee").id;
    S().newBill("coffee");
    S().addToCart("coffee", "capp", 1);

    expect(await S().pay("coffee", "Cash")).toBe("CF/1188");

    expect(bodiesOf("POST /api/v1/bills")[0].lines).toEqual([{ it: "capp", qty: 1 }]);
    expect(bills().map((b) => b.id)).toEqual([held]);
    expect(cartOf(S(), "coffee")).toEqual({ juice: 2 });
  });

  it("takes off the bill that was paid, not the one the operator moved to meanwhile", async () => {
    let answer!: () => void;
    serve({ "POST /api/v1/bills": () => new Promise<Response>((r) => { answer = () => r(paid()); }) });
    S().addToCart("coffee", "juice", 1);
    const paying = activeBill(S(), "coffee").id;
    S().newBill("coffee");
    S().addToCart("coffee", "capp", 3);
    const next = activeBill(S(), "coffee").id;
    S().switchBill("coffee", paying);

    const done = S().pay("coffee", "Cash");
    S().switchBill("coffee", next);                          // on to the next customer
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    answer();
    expect(await done).toBe("CF/1188");

    expect(bills().map((b) => b.id)).toEqual([next]);
    expect(cartOf(S(), "coffee")).toEqual({ capp: 3 });
  });

  it("leaves a refused bill on the till exactly as it was", async () => {
    serve({ "POST /api/v1/bills": () => refusal("Only 2 nos of Fresh Juice 200ml left at Coffee Shop") });
    S().addToCart("coffee", "juice", 3);
    S().setBill("coffee", { custName: "Anitha S" });
    S().newBill("coffee");
    S().switchBill("coffee", bills()[0].id);

    expect(await S().pay("coffee", "Cash")).toBeNull();
    expect(bills()).toHaveLength(2);
    expect(activeBill(S(), "coffee")).toMatchObject({ lines: { juice: 3 }, custName: "Anitha S" });
  });

  it("drops every open bill on sign-out", async () => {
    serve({ "POST /api/v1/auth/logout": () => json({ ok: true }) });
    S().addToCart("coffee", "juice", 1);
    S().setBill("coffee", { custName: "Anitha S", custPhone: "9843022118" });
    S().newBill("coffee");
    await S().logout();
    expect(S().tills).toEqual({});
  });
});

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(Pos))); });
  const input = (label: string) => {
    const l = [...host.querySelectorAll("label")].find((x) => x.textContent === label)!;
    return host.querySelector<HTMLInputElement>(`#${CSS.escape(l.htmlFor)}`)!;
  };
  return {
    host,
    input,
    tabs: () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')],
    button: (starts: string) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(starts))!,
    labelled: (l: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${l}"]`),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
const click = (b: HTMLElement) => act(() => { b.click(); });

describe("the till's bill tabs", () => {
  it("draws a chip per open bill, counts them, and shuts New bill at ten", () => {
    const ui = mount();
    expect(ui.tabs()).toHaveLength(1);
    for (let i = 1; i < MAX_OPEN_BILLS; i += 1) click(ui.button("+ New bill"));
    expect(ui.tabs().map((t) => t.querySelector("b")!.textContent)).toEqual(
      Array.from({ length: MAX_OPEN_BILLS }, (_, i) => `Bill ${i + 1}`));
    expect(ui.button("+ New bill").disabled).toBe(true);
    expect(ui.host.textContent).toContain(`${MAX_OPEN_BILLS} of ${MAX_OPEN_BILLS} open`);
    // The chip on screen is the one selected, and the bill card carries its number.
    expect(ui.tabs().filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.textContent)).toEqual([`Bill ${MAX_OPEN_BILLS}`]);
    expect([...ui.host.querySelectorAll(".card-t h3")].map((h) => h.textContent)).toContain(`Bill ${MAX_OPEN_BILLS}`);
    ui.unmount();
  });

  it("shows each bill's own customer when its tab is picked", () => {
    const ui = mount();
    act(() => { S().setBill("coffee", { custName: "Anitha S" }); });
    click(ui.button("+ New bill"));
    expect(ui.input("Customer name").value).toBe("");
    click(ui.tabs()[0]);
    expect(ui.input("Customer name").value).toBe("Anitha S");
    ui.unmount();
  });

  it("offers discard on the bill on screen alone, and takes one with lines only at the second press", () => {
    const ui = mount();
    act(() => { S().addToCart("coffee", "juice", 1); });
    click(ui.button("+ New bill"));
    expect(ui.labelled("Discard bill 1")).toBeNull();
    expect(ui.labelled("Discard bill 2")).not.toBeNull();
    click(ui.tabs()[0]);
    click(ui.labelled("Discard bill 1")!);
    expect(ui.tabs()).toHaveLength(2);
    click(ui.labelled("Discard bill 1 - press again")!);
    expect(ui.tabs()).toHaveLength(1);
    expect(ui.tabs()[0].textContent).toContain("Bill 2");
    ui.unmount();
  });

  it("lets the next bill be paid while the first is still in flight", async () => {
    let answer!: () => void;
    serve({
      "POST /api/v1/bills": () => new Promise<Response>((r) => { answer = () => r(paid()); }),
      "GET /api/v1/bills": () => json([BILL]),
    });
    const ui = mount();
    act(() => { S().addToCart("coffee", "juice", 1); });
    click(ui.button("Pay"));
    expect(ui.button("Taking the bill").disabled).toBe(true);
    expect(ui.tabs()[0].textContent).toContain("Paying…");

    click(ui.button("+ New bill"));
    act(() => { S().addToCart("coffee", "capp", 1); });
    expect(ui.button("Pay").disabled).toBe(false);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => { answer(); await Promise.resolve(); });
    await vi.waitFor(() => expect(ui.tabs()).toHaveLength(1));
    expect(cartOf(S(), "coffee")).toEqual({ capp: 1 });
    expect(S().drawer).toEqual({ t: "cbill", id: "CF/1188" });
    ui.unmount();
  });
});
