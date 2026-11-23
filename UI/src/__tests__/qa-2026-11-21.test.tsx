import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { DESK_DEFAULTS } from "@rch/domain";
import { useApp } from "../store";
import { menuOf } from "../lib/selectors";
import type { Bill, Dated, Permissions, ProdOrder, RegisterReport } from "../types";
import { as, deskScreens, resetStore, S, userOf } from "./fixture";

/**
 * The defects the testing team's reports of 21-Nov-2026 turned up, each pinned by its id in
 * `docs/qa/2026-11-21-qa-report-triage.md`. The server's halves (X1, X9, V9) are pinned in
 * `apps/api/src/modules/receivables/receivables.test.ts`, and the Credit screen's (V6, V9) in
 * `manager-credit.test.tsx`.
 */

const counter = deskScreens("counter");
const manager = deskScreens("manager");
const DAY = 86_400_000;

const mounted: { unmount: () => void }[] = [];
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); });
beforeEach(() => { resetStore(); });

function mount(C: ComponentType) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(C))); });
  const ui = {
    host,
    text: () => host.textContent ?? "",
    rows: () => [...host.querySelectorAll("tbody tr")].filter((tr) => !tr.querySelector(".empty")),
    select: (label: string) => [...host.querySelectorAll<HTMLSelectElement>("select")]
      .find((x) => x.getAttribute("aria-label") === label || (x.closest("label")?.textContent ?? "").includes(label)),
    button: (label: string) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
  mounted.push(ui);
  return ui;
}
const settle = async () => {
  await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
};
const kpi = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll(".kpi")].find((k) => k.querySelector(".kl")?.textContent === label);

const TOTALS: RegisterReport["totals"] = {
  grossSales: 0, discount: 0, nettSales: 0, creditSales: 0, voidAmount: 0, voidBills: 0,
  tip: 0, parcelCharge: 0, deliveryCharge: 0, additionalCharge: 0,
  complimentary: 0, unCollected: 0, unCollectedDiscount: 0,
  tenders: [], collected: 0, oldBills: [], oldBillsTotal: 0, sgst: 0, cgst: 0, taxTotal: 0, billCount: 0,
};
const xReport = (over: Partial<RegisterReport> & { bills?: number; nett?: number } = {}): RegisterReport => {
  const { bills = 0, nett = 0, ...rest } = over;
  return {
    kind: "X", zNo: null, sessionId: "SES-coffee", loc: "coffee", previousZNo: null,
    openedAt: new Date(Date.now() - 3600_000).toISOString(), closedAt: null,
    takenAt: new Date().toISOString(), takenBy: "Kavitha Raman",
    totals: { ...TOTALS, billCount: bills, nettSales: nett, collected: nett, tenders: bills ? [{ tender: "Cash", amount: nett, bills }] : [] },
    ...rest,
  };
};
const aBill = (no: string, iso: string, tot: number): Dated<Bill> => ({
  no, loc: "coffee", opr: "Kavitha Raman", oprCol: "#0EA5E9", tot, tax: 0,
  t: "10:00", iso, pay: "Cash", lines: [{ it: "juice", qty: 1, rate: tot }],
});
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function signInCounter(set: Partial<Record<string, "view" | "edit" | null>> = {}) {
  const perms: Permissions = JSON.parse(JSON.stringify(DESK_DEFAULTS.counter.perms)) as Permissions;
  for (const [f, l] of Object.entries(set)) {
    if (l === null) delete (perms.f as Record<string, unknown>)[f]; else (perms.f as Record<string, unknown>)[f] = l;
  }
  act(() => { useApp.setState({ user: { ...userOf("counter"), perms }, auth: "ready" }); });
}

describe("V2 - the Bills screen counts the register session, as the dashboard does", () => {
  it("lists the session's bills from an earlier day, and Today narrows to today's", async () => {
    act(() => {
      as("counter");
      useApp.setState({
        readXReport: vi.fn(async () => xReport({ openedAt: ago(3), bills: 2, nett: 300 })),
        bills: [aBill("CF/3003", ago(0), 100), aBill("CF/3002", ago(2), 200), aBill("CF/3001", ago(5), 999)],
      });
    });
    const ui = mount(counter.bills);
    await settle();

    expect(ui.text()).toContain("CF/3003");
    expect(ui.text()).toContain("CF/3002");
    // Before the session opened: it belongs to a day already settled by a Z.
    expect(ui.text()).not.toContain("CF/3001");
    expect(ui.text()).not.toContain("No bill raised at this counter");

    const pick = ui.select("Window")!;
    expect(pick).toBeTruthy();
    await act(async () => {
      pick.value = "Today";
      pick.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(ui.text()).toContain("CF/3003");
    expect(ui.text()).not.toContain("CF/3002");
  });

  it("says when the session's bills are older than the 7 days the screen holds", async () => {
    act(() => {
      as("counter");
      useApp.setState({ readXReport: vi.fn(async () => xReport({ openedAt: ago(11), bills: 8, nett: 1078 })), bills: [] });
    });
    const ui = mount(counter.bills);
    await settle();
    expect(ui.text()).toContain("8 more bills belong to this session");
    expect(ui.text()).toContain("This session's bills are older than this screen holds");
    expect(ui.text()).not.toContain("No bill raised at this counter");
  });

  it("is today's alone for a role without X reports, which cannot read the session", async () => {
    signInCounter({ x_report: null });
    const readXReport = vi.fn(async () => xReport());
    act(() => { useApp.setState({ readXReport, bills: [aBill("CF/3003", ago(0), 100), aBill("CF/3002", ago(2), 200)] }); });
    const ui = mount(counter.bills);
    await settle();
    expect(readXReport).not.toHaveBeenCalled();
    expect(ui.text()).toContain("CF/3003");
    expect(ui.text()).not.toContain("CF/3002");
    expect(ui.select("Window")).toBeUndefined();
  });
});

describe("V3 / X7 / X8 - the counter's dashboard", () => {
  it("prints takings to the paisa and names the day a session opened before today", async () => {
    act(() => {
      as("counter");
      useApp.setState({
        readXReport: vi.fn(async () => xReport({ openedAt: "2026-11-15T12:06:15.917Z", bills: 5, nett: 4598.2 })),
        bills: [],
      });
    });
    const ui = mount(counter.dash);
    await settle();
    expect(kpi(ui.host, "Billed this session")?.querySelector(".kv")?.textContent).toBe("₹4,598.20");
    expect(ui.text()).toContain("since this register first opened, 15-Nov-2026 17:36");
  });

  it("says the session's bills are older than it holds, not that nothing was billed", async () => {
    act(() => {
      as("counter");
      useApp.setState({ readXReport: vi.fn(async () => xReport({ openedAt: ago(11), bills: 8, nett: 1078 })), bills: [] });
    });
    const ui = mount(counter.dash);
    await settle();
    expect(ui.text()).toContain("This session's bills are older than this screen holds");
    expect(ui.text()).toContain("All 8 bills of this session were raised before the last 7 days");
    expect(ui.text()).not.toContain("Nothing billed at this counter yet");
    expect(ui.text()).not.toContain("Nothing billed in this session");
    expect(kpi(ui.host, "Bills raised")?.textContent).toContain("before the last 7 days");
  });
});

describe("V7 - unavailable products are split into switched off and out of stock", () => {
  it("labels the tile by what it counts and says how many were switched off", async () => {
    act(() => { as("counter"); useApp.setState({ readXReport: vi.fn(async () => xReport()) }); });
    // Switch one product off by hand; whatever else is off here is off for want of stock.
    const it0 = menuOf(S(), "coffee")[0];
    act(() => { useApp.setState({ ovr: { ...S().ovr, [`coffee:${it0}`]: "Machine is down" } }); });
    const ui = mount(counter.dash);
    await settle();
    const tile = kpi(ui.host, "Products unavailable");
    expect(tile).toBeTruthy();
    expect(tile?.textContent).toMatch(/\d+ switched off · \d+ out of stock/);
    expect(ui.text()).not.toContain("Products switched off");
  });
});

describe("V5 - a kitchen order still on the board counts as open", () => {
  const order = (id: string, st: ProdOrder["st"]) => ({
    id, from: "coffee", by: "Kavitha Raman", at: "10:00", iso: ago(2), t: "10:00",
    lines: [{ it: "juice", qty: 5 }], st, note: "", hist: [],
  }) as unknown as ReturnType<typeof S>["pord"][number];

  it("on the dashboard and on the Requests screen's footer", async () => {
    act(() => {
      as("counter");
      useApp.setState({
        readXReport: vi.fn(async () => xReport()),
        pord: [order("PRD-2026-901", "New"), order("PRD-2026-902", "Ready"), order("PRD-2026-903", "Dispatched")],
      });
    });
    const dash = mount(counter.dash);
    await settle();
    expect(kpi(dash.host, "Kitchen orders open")?.querySelector(".kv")?.textContent).toBe("2");

    const req = mount(counter["outlet-requests"]);
    await settle();
    expect(req.text()).toContain("2 kitchen orders still on the kitchen's board");
  });
});

describe("X6 - Submit request is never greyed out by the quantity boxes", () => {
  it("answers an empty request with a sentence instead of a dead button", async () => {
    act(() => { as("counter"); useApp.setState({ draft: [] }); });
    const ui = mount(counter["outlet-requests"]);
    await settle();
    const submit = ui.button("Submit request")!;
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });
    expect(S().toast).toBe("Add at least one line with a quantity");
  });
});

describe("X7 - the manager's dashboard on an outlet with nothing open", () => {
  it("says nothing has been billed, rather than a session opened at the time it was read", async () => {
    act(() => {
      as("manager");
      useApp.setState({
        readXReport: vi.fn(async (loc?: string) => xReport({ loc: loc ?? "coffee", sessionId: "", openedAt: new Date().toISOString() })),
      });
    });
    const ui = mount(manager.dash);
    await settle();
    expect(ui.text()).toContain("nothing billed yet");
    expect(ui.text()).not.toContain("since it first opened");
  });
});
