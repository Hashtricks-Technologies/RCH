import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { refetch } from "../api/refetch";
import { setAccessToken } from "../api/session";
import CloseShift from "../ui/CloseShift";
import ShiftReports from "../ui/ShiftReports";
import Shell from "../ui/Shell";
import { useApp } from "../store";
import type { ShiftReport } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * Close Shift from the counter's side, and the hand-over from the manager's: the store's three
 * shift calls on the wire, the dialog that shows the live report and closes it, the manager's
 * Shift reports card and the bell row a close puts there. The rules - whose bills, which window,
 * what is stored - belong to `apps/api/src/modules/shifts/shifts.test.ts`.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (message: string, status = 422) => json({ error: { code: "rule", message } }, status);

const fetchMock = vi.fn();
type Stubs = Record<string, () => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make
      ? make()
      : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const hit = (at: string) => fetchMock.mock.calls.filter((c) => {
  const [u, init] = c as [string, RequestInit];
  return `${init.method} ${String(u).split("?")[0]}` === at;
});

const NOW = new Date().toISOString();
const tenders = (cash: number, upi: number, card: number) => [
  { tender: "Cash", amount: cash, bills: cash ? 1 : 0 },
  { tender: "UPI", amount: upi, bills: upi ? 1 : 0 },
  { tender: "Card", amount: card, bills: card ? 1 : 0 },
  { tender: "Staff credit", amount: 0, bills: 0 },
  { tender: "Doctor credit", amount: 0, bills: 0 },
  { tender: "Dept", amount: 0, bills: 0 },
];
const shift = (over: Partial<ShiftReport> = {}): ShiftReport => ({
  id: "SH-2026-0007", loc: "coffee", userId: "u1", operator: "Kavitha Raman",
  openedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), closedAt: null, takenAt: NOW, auto: false,
  totals: {
    billCount: 3, grossSales: 4320, discount: 0, nettSales: 4320, taxTotal: 205.71,
    tenders: tenders(2000, 1500, 820), collected: 4320, creditSales: 0, voidAmount: 0, voidBills: 0,
  },
  ...over,
});
const CLOSED = shift({ closedAt: NOW });
const KIOSK = shift({ id: "SH-2026-0006", loc: "kiosk", userId: "u6", operator: "Deepa Selvam", closedAt: NOW, auto: true,
  totals: { ...shift().totals, billCount: 1, nettSales: 90, grossSales: 90, collected: 90, tenders: tenders(90, 0, 0) } });

function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(MemoryRouter, { initialEntries: ["/dash"] },
      createElement(Routes, null,
        createElement(Route, { path: "/login", element: createElement("p", null, "signed out") }),
        createElement(Route, { path: "*", element: el }))));
  });
  return { host, unmount: () => { act(() => { root.unmount(); }); host.remove(); } };
}
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);

let print: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  localStorage.clear();
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setAccessToken("tok");
  print = vi.spyOn(window, "print").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); print.mockRestore(); localStorage.clear(); });

describe("the store's shift calls", () => {
  it("reads the live shift, and tells an outage from a session with none open", async () => {
    as("counter");
    serve({ "GET /api/v1/shifts/current": () => json({ shift: shift() }) });
    expect((await S().readCurrentShift())?.shift?.id).toBe("SH-2026-0007");
    serve({ "GET /api/v1/shifts/current": () => json({ shift: null }) });
    expect(await S().readCurrentShift()).toEqual({ shift: null });
    serve({});
    expect(await S().readCurrentShift()).toBeNull();
  });

  it("closes with the server's own sentence, and toasts a refusal word for word", async () => {
    as("counter");
    serve({ "POST /api/v1/shifts/close": () => json({ result: CLOSED, changed: ["shifts"], message: "SH-2026-0007 closed your shift at Coffee Shop - ₹4,320.00 over 3 bills. Sign in again to start the next one." }) });
    expect((await S().closeShift())?.id).toBe("SH-2026-0007");
    expect(S().toast).toContain("closed your shift at Coffee Shop");
    // A counter reads nothing back: the list is the manager's.
    expect(hit("GET /api/v1/shifts")).toHaveLength(0);

    serve({ "POST /api/v1/shifts/close": () => refusal("Refused - you have no open shift to close; sign in again at your counter to start one.") });
    expect(await S().closeShift()).toBeNull();
    expect(S().toast).toContain("you have no open shift to close");

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await S().closeShift()).toBeNull();
    expect(S().toast).toContain("Could not close the shift");
  });

  it("loads the manager's list, marks a failed load, and a shifts notice pulls it back for the manager alone", async () => {
    as("manager");
    serve({ "GET /api/v1/shifts": () => json([CLOSED]) });
    await refetch(["shifts"]);
    expect(S().shifts.map((r) => r.id)).toEqual(["SH-2026-0007"]);
    expect(S().shiftsFailed).toBe(false);

    serve({});
    expect(await S().loadShifts()).toBe(false);
    expect(S().shiftsFailed).toBe(true);

    fetchMock.mockReset();
    as("counter");
    await refetch(["shifts"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Close Shift, from the counter", () => {
  it("shows the live report per tender, closes it, prints the slip and signs out", async () => {
    as("counter");
    serve({
      "GET /api/v1/shifts/current": () => json({ shift: shift() }),
      "POST /api/v1/shifts/close": () => json({ result: CLOSED, changed: ["shifts"], message: "SH-2026-0007 closed your shift at Coffee Shop - ₹4,320.00 over 3 bills. Sign in again to start the next one." }),
      "POST /api/v1/auth/logout": () => json({ ok: true }),
    });
    const m = mount(createElement(CloseShift));
    act(() => { button("Close shift")!.click(); });
    await settle();

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("SH-2026-0007");
    expect(dialog.textContent).toContain("UPI");
    expect(dialog.textContent).toContain("Total billed");
    // The slip is on the page for the Print button, outside the dialog so it reaches paper.
    expect(document.querySelector(".print-slip.shift-slip")?.textContent).toContain("Kavitha Raman");

    act(() => { button("Print")!.click(); });
    expect(print).toHaveBeenCalledTimes(1);

    act(() => { button("Close shift & sign out")!.click(); });
    await settle();
    expect(hit("POST /api/v1/shifts/close")).toHaveLength(1);
    expect(print).toHaveBeenCalledTimes(2);
    expect(hit("POST /api/v1/auth/logout")).toHaveLength(1);
    expect(S().user).toBeNull();
    expect(m.host.textContent).toContain("signed out");
    m.unmount();
  });

  it("keeps the operator signed in when the close is refused", async () => {
    as("counter");
    serve({
      "GET /api/v1/shifts/current": () => json({ shift: shift() }),
      "POST /api/v1/shifts/close": () => refusal("Refused - your open shift is at Snack Kiosk, not Coffee Shop; close it there, or sign in here to start one."),
    });
    const m = mount(createElement(CloseShift));
    act(() => { button("Close shift")!.click(); });
    await settle();
    act(() => { button("Close shift & sign out")!.click(); });
    await settle();
    expect(S().user).not.toBeNull();
    expect(print).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    m.unmount();
  });

  it("says so when no shift is open, and offers only the sign-out", async () => {
    as("counter");
    serve({ "GET /api/v1/shifts/current": () => json({ shift: null }), "POST /api/v1/auth/logout": () => json({ ok: true }) });
    const m = mount(createElement(CloseShift));
    act(() => { button("Close shift")!.click(); });
    await settle();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("No shift is open for you");
    expect(button("Close shift & sign out")).toBeUndefined();
    act(() => { button("Sign out")!.click(); });
    await settle();
    expect(S().user).toBeNull();
    m.unmount();
  });

  it("names an outage rather than a shift that billed nothing, and Keep working puts it away", async () => {
    as("counter");
    serve({});
    const m = mount(createElement(CloseShift));
    act(() => { button("Close shift")!.click(); });
    await settle();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Could not read your shift");
    act(() => { button("Keep working")!.click(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    m.unmount();
  });

  it("is in the counter's sidebar and nobody else's", async () => {
    as("counter");
    serve({});
    const c = mount(createElement(Shell, null, createElement("p", null, "screen")));
    expect(c.host.querySelector(".sf")!.textContent).toContain("Close shift");
    c.unmount();
    as("manager");
    serve({ "GET /api/v1/shifts": () => json([]) });
    const m = mount(createElement(Shell, null, createElement("p", null, "screen")));
    expect(m.host.querySelector(".sf")!.textContent).not.toContain("Close shift");
    m.unmount();
  });
});

describe("the manager's hand-over", () => {
  it("lists every closed shift with its tenders, filters by outlet, and prints one", async () => {
    as("manager");
    serve({ "GET /api/v1/shifts": () => json([CLOSED, KIOSK]) });
    const m = mount(createElement(ShiftReports));
    await settle();
    const rows = () => [...m.host.querySelectorAll("tbody tr")].map((r) => r.textContent ?? "");
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toContain("Kavitha Raman");
    expect(rows()[0]).toContain("₹2,000.00 · ₹1,500.00 · ₹820.00");
    expect(rows()[1]).toContain("Auto");

    const select = m.host.querySelector<HTMLSelectElement>("select")!;
    act(() => {
      select.value = [...select.options].find((o) => o.text.startsWith("Snack Kiosk"))!.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain("Deepa Selvam");

    act(() => { [...m.host.querySelectorAll<HTMLButtonElement>("tbody button")].find((b) => b.textContent === "Print")!.click(); });
    await settle();
    expect(print).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".print-slip.shift-slip")!.textContent).toContain("closed automatically");
    m.unmount();
  });

  it("shows an outage line, not an empty list, when the shifts cannot be read", async () => {
    as("manager");
    serve({});
    const m = mount(createElement(ShiftReports));
    await settle();
    expect(m.host.textContent).toContain("Could not read the shift reports");
    m.unmount();
  });

  it("puts today's closes on the bell, naming the latest", async () => {
    as("manager");
    serve({ "GET /api/v1/shifts": () => json([CLOSED, KIOSK]) });
    const m = mount(createElement(Shell, null, createElement("p", null, "screen")));
    await settle();
    act(() => { m.host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click(); });
    const row = [...m.host.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent?.includes("Shifts closed today"));
    expect(row?.textContent).toContain("Kavitha Raman closed their shift at Coffee Shop · ₹4,320");
    expect(row?.textContent).toContain("2");
    m.unmount();
    expect(useApp.getState().shifts).toHaveLength(2);
  });
});
