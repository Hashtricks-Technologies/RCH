import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import AdminRegisters from "../pages/AdminRegisters";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import { LOC } from "../data/master";
import type { AdminLocation, RegisterReport } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * The Registers tab: every outlet's X, its closed sessions and the Z that closes the day, as the
 * super admin reads them. The admin loads no snapshot, so the outlets come from its own list,
 * every call names its outlet, and the slip names the outlet it was handed.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn();
type Stubs = Record<string, (url: URL) => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const url = new URL(String(u), "http://x");
    const make = stubs[`${init.method} ${url.pathname}`];
    return Promise.resolve(make ? make(url) : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const hit = (at: string) =>
  fetchMock.mock.calls.filter(([u, init]) => `${(init as RequestInit).method} ${new URL(String(u), "http://x").pathname}` === at);

const loc = (over: Partial<AdminLocation>): AdminLocation => ({
  key: "rest", n: "Restaurant", c: "OT-R1", type: "Outlet", floor: "Floor 1", cc: "CC-RST", active: true, staff: 1, ...over,
});
const LOCS: AdminLocation[] = [
  loc({ key: "store", n: "Central Store", c: "WH-CS", type: "Store" }),
  loc({ key: "kitchen", n: "Central Kitchen", c: "KT-CK", type: "Kitchen" }),
  loc({ key: "rest", n: "Restaurant" }),
  loc({ key: "coffee", n: "Coffee Shop", c: "OT-CS" }),
  loc({ key: "kiosk", n: "Snack Kiosk", c: "OT-GK", active: false }),
];

const TOTALS: RegisterReport["totals"] = {
  grossSales: 4820, discount: 120, nettSales: 4700, creditSales: 900, voidAmount: 60, voidBills: 1,
  tip: 0, parcelCharge: 0, deliveryCharge: 0, additionalCharge: 0, complimentary: 0, unCollected: 0, unCollectedDiscount: 0,
  tenders: [{ tender: "Cash", amount: 2600, bills: 18 }], collected: 2600,
  oldBills: [], oldBillsTotal: 0, sgst: 111.9, cgst: 111.9, taxTotal: 223.8, billCount: 26,
};
const x = (l: string): RegisterReport => ({
  kind: "X", zNo: null, sessionId: `SES-${l}-12`, loc: l, previousZNo: "Z-0041",
  openedAt: "2026-09-17T13:00:00.000Z", closedAt: null, takenAt: "2026-09-18T05:30:00.000Z", takenBy: "System Administrator", totals: TOTALS,
});
const z = (l: string, zNo: string): RegisterReport => ({ ...x(l), kind: "Z", zNo, closedAt: "2026-09-18T05:30:00.000Z" });

const tick = () => act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });

async function mountPage() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(AdminRegisters))); });
  await tick();
  return {
    host,
    text: () => host.textContent ?? "",
    button: (label: string, scope: ParentNode = host) =>
      [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label),
    outlet: () => host.querySelector<HTMLSelectElement>('select[aria-label="Outlet"]')!,
    cash: () => host.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!,
    slip: () => host.querySelector(".print-slip")?.textContent ?? "",
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Page = Awaited<ReturnType<typeof mountPage>>;

const press = async (b: HTMLElement | undefined) => {
  expect(b, "no such button").toBeTruthy();
  await act(async () => { b!.click(); await new Promise((r) => { setTimeout(r, 0); }); });
};
const choose = async (sel: HTMLSelectElement | HTMLInputElement, v: string) => {
  await act(async () => {
    const proto = sel instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(sel, v);
    sel.dispatchEvent(new Event(sel instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    await new Promise((r) => { setTimeout(r, 0); });
  });
};

let page: Page | undefined;
let printed: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  printed = vi.fn();
  Object.defineProperty(window, "print", { value: printed, configurable: true, writable: true });
  act(() => {
    as("manager");
    setAccessToken("admin-tok");
    useApp.setState({ user: { ...S().user!, admin: true }, adminLocations: LOCS });
  });
  // The admin's session loads no snapshot: nothing in the location master to read a name from.
  for (const k of Object.keys(LOC)) delete LOC[k];
});
afterEach(() => { page?.unmount(); page = undefined; vi.unstubAllGlobals(); setAccessToken(null); });

const REGISTER: Stubs = {
  "GET /api/v1/register/x": (u) => json(x(u.searchParams.get("loc") ?? "")),
  "GET /api/v1/register/z": (u) => json([z(u.searchParams.get("loc") ?? "", u.searchParams.get("loc") === "rest" ? "Z-0099" : "Z-0042")]),
};

describe("the Registers tab", () => {
  it("offers the outlets alone, open ones first and a closed one named so, and reads the first", async () => {
    serve(REGISTER);
    page = await mountPage();
    expect([...page.outlet().options].map((o) => o.value)).toEqual(["Coffee Shop", "Restaurant", "Snack Kiosk (closed)"]);
    // Every read names its outlet: the register routes admit the admin token only with one.
    expect(hit("GET /api/v1/register/x")[0][0]).toContain("loc=coffee");
    expect(hit("GET /api/v1/register/z")[0][0]).toContain("loc=coffee");
    expect(page.text()).toContain("Coffee Shop register");
    expect(page.text()).toContain("Take X-report");
    expect(page.text()).toContain("Close register & take Z");
    expect(page.text()).toContain("Z-0042");
    // No Shift reports card: that list is an operator's.
    expect(page.text()).not.toContain("Shift reports");
  });

  it("picks another outlet and reads its register", async () => {
    serve(REGISTER);
    page = await mountPage();
    await choose(page.outlet(), "Restaurant");
    await tick();
    expect(hit("GET /api/v1/register/x").at(-1)![0]).toContain("loc=rest");
    expect(hit("GET /api/v1/register/z").at(-1)![0]).toContain("loc=rest");
    expect(page.text()).toContain("Restaurant register");
    expect(page.text()).toContain("Z-0099");
    expect(page.text()).not.toContain("Z-0042");
  });

  it("takes an X: reads again and prints a slip that names the outlet", async () => {
    serve(REGISTER);
    page = await mountPage();
    await press(page.button("Take X-report"));
    expect(hit("GET /api/v1/register/x")).toHaveLength(2);
    expect(printed).toHaveBeenCalledTimes(1);
    expect(page.slip()).toContain("X-report - Coffee Shop");
    expect(hit("POST /api/v1/register/close")).toHaveLength(0);
  });

  it("takes the Z with the counted cash, prints it, and reads nothing an admin may not", async () => {
    serve({
      ...REGISTER,
      "POST /api/v1/register/close": () => json({ result: z("coffee", "Z-0043"), changed: ["bills"], message: "Z-0043 closed the Coffee Shop register." }),
    });
    page = await mountPage();
    await press(page.button("Close register & take Z"));
    expect(page.text()).toContain("It cannot be undone or taken again");
    expect(hit("POST /api/v1/register/close")).toHaveLength(0);
    await choose(page.cash(), "2600");
    await press(page.button("Yes, take the Z"));
    const [, init] = hit("POST /api/v1/register/close")[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ loc: "coffee", countedCash: 2600 });
    // The write names `bills`, which the admin's token cannot read: nothing is asked for, and the
    // server's sentence is not qualified with "could not be refreshed".
    expect(hit("GET /api/v1/bills")).toHaveLength(0);
    expect(S().toast).toBe("Z-0043 closed the Coffee Shop register.");
    expect(printed).toHaveBeenCalled();
    expect(page.slip()).toContain("Z-report - Coffee Shop");
    expect(page.slip()).toContain("Z-0043");
  });

  it("prints a past Z off the list", async () => {
    serve(REGISTER);
    page = await mountPage();
    await press(page.button("Print"));
    expect(printed).toHaveBeenCalledTimes(1);
    expect(page.slip()).toContain("Z-0042");
    expect(page.slip()).toContain("Coffee Shop");
  });

  it("says so when no outlet exists", async () => {
    serve(REGISTER);
    act(() => { useApp.setState({ adminLocations: LOCS.filter((l) => l.type !== "Outlet") }); });
    page = await mountPage();
    expect(page.text()).toContain("No outlet is open");
    expect(hit("GET /api/v1/register/x")).toHaveLength(0);
  });
});
