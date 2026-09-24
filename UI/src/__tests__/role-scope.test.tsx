import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESK_DEFAULTS } from "@rch/domain";
import type { Action, Feature, Level, Permissions, Role } from "@rch/contract";
import { useApp } from "../store";
import { openOutlets } from "../lib/selectors";
import CounterDashboard from "../roles/counter/Dashboard";
import ManagerDashboard from "../roles/manager/Dashboard";
import CounterBills from "../roles/counter/Bills";
import StoreReports from "../roles/store/Reports";
import type { RegisterReport } from "../types";
import { resetStore, userOf } from "./fixture";

/**
 * What a narrowed role's always-visible screens read and offer.
 *
 * A dashboard is desk-bound and shown to every role on its desk, whatever the role holds, so it
 * is the one screen that must ask for itself: read the X only for a role holding X reports (the
 * server answers anyone else 404), read every outlet's only with "Works for every outlet", draw a
 * sales figure only for a role that can see Bills, and never draw a link to a screen the role
 * cannot open - it would land them on "that screen is not part of your role".
 */

beforeEach(resetStore);
const mounted: (() => void)[] = [];
afterEach(() => { while (mounted.length) mounted.pop()!(); });

/** Sign in as `desk`'s seeded role with `set` applied on top: a level, or `null` to take it away. */
function signIn(desk: Role, set: Partial<Record<Feature, Level | null>> = {}, actions?: Action[]) {
  const perms: Permissions = JSON.parse(JSON.stringify(DESK_DEFAULTS[desk].perms)) as Permissions;
  for (const [f, l] of Object.entries(set) as [Feature, Level | null][]) {
    if (l === null) delete perms.f[f]; else perms.f[f] = l;
  }
  if (actions) perms.a = actions;
  act(() => { useApp.setState({ user: { ...userOf(desk), perms }, auth: "ready" }); });
}

const xReport = (loc: string): RegisterReport => ({
  kind: "X", zNo: null, sessionId: `SES-${loc}`, loc, previousZNo: null,
  openedAt: "2020-01-01T00:00:00.000Z", closedAt: null, takenAt: "2020-01-01T00:00:00.000Z", takenBy: "x",
  totals: {
    grossSales: 0, discount: 0, nettSales: 0, creditSales: 0, voidAmount: 0, voidBills: 0,
    tip: 0, parcelCharge: 0, deliveryCharge: 0, additionalCharge: 0, complimentary: 0,
    unCollected: 0, unCollectedDiscount: 0, tenders: [], collected: 0, oldBills: [], oldBillsTotal: 0,
    sgst: 0, cgst: 0, taxTotal: 0, billCount: 0,
  },
});

/** Stub the X; `fail` answers `null`, the outage. */
function stubX(fail = false) {
  const readXReport = vi.fn(async (loc?: string) => (fail ? null : xReport(loc ?? "")));
  act(() => { useApp.setState({ readXReport }); });
  return readXReport;
}

async function mount(C: ComponentType) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(C))); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  mounted.push(() => { act(() => { root.unmount(); }); host.remove(); });
  const buttons = () => [...host.querySelectorAll("button")].map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim());
  return {
    host,
    text: () => host.textContent ?? "",
    has: (label: string) => buttons().includes(label),
    kpis: () => [...host.querySelectorAll(".kpi .kl")].map((k) => k.textContent ?? ""),
    alerts: () => [...host.querySelectorAll(".al")].map((a) => a.textContent ?? ""),
  };
}

describe("the counter's dashboard", () => {
  it("as seeded reads its own X and draws the takings and its links", async () => {
    signIn("counter");
    const readX = stubX();
    const ui = await mount(CounterDashboard);
    expect(readX).toHaveBeenCalledWith("coffee");
    expect(ui.kpis()).toContain("Billed this session");
    expect(ui.has("Open till")).toBe(true);
    expect(ui.has("Raise a request")).toBe(true);
    expect(ui.has("Register")).toBe(true);
  });

  it("without X reports never reads the register, draws no takings and no outage", async () => {
    signIn("counter", { x_report: null });
    const readX = stubX(true);
    const ui = await mount(CounterDashboard);
    expect(readX).not.toHaveBeenCalled();
    expect(ui.kpis()).not.toContain("Billed this session");
    expect(ui.kpis()).toContain("Products switched off");
    expect(ui.alerts().some((a) => a.includes("OUTAGE"))).toBe(false);
    expect(ui.text()).not.toContain("Last five bills");
    expect(ui.has("Register")).toBe(false);
  });

  it("with X reports and a failed read says so", async () => {
    signIn("counter");
    stubX(true);
    const ui = await mount(CounterDashboard);
    expect(ui.alerts().some((a) => a.includes("The register could not be read"))).toBe(true);
  });

  it("draws no link to the till, the requests or the bills for a role that cannot open them", async () => {
    signIn("counter", { billing: null, outlet_requests: null, outlet_tickets: null });
    stubX();
    const ui = await mount(CounterDashboard);
    expect(ui.has("Open till")).toBe(false);
    expect(ui.has("Raise a request")).toBe(false);
    expect(ui.has("All requests")).toBe(false);
    expect(ui.has("All bills")).toBe(false);
  });
});

describe("the counter's Bills at view", () => {
  it("offers no new bill and no till, since the till is Bills at edit", async () => {
    signIn("counter", { billing: "view" });
    const ui = await mount(CounterBills);
    expect(ui.has("New bill")).toBe(false);
    expect(ui.has("Open till")).toBe(false);
  });

  it("at edit offers both", async () => {
    act(() => { useApp.setState({ bills: [] }); });
    signIn("counter");
    const ui = await mount(CounterBills);
    expect(ui.has("New bill")).toBe(true);
    expect(ui.has("Open till")).toBe(true);
  });
});

describe("the manager's dashboard", () => {
  it("as seeded reads every open outlet's X and draws the sales", async () => {
    signIn("manager");
    const readX = stubX();
    const ui = await mount(ManagerDashboard);
    expect(readX).toHaveBeenCalledTimes(openOutlets().length);
    expect(ui.kpis()).toContain("Billed across open sessions");
    expect(ui.text()).toContain("Session sales");
    expect(ui.has("Open approvals")).toBe(true);
  });

  it("with X reports but not every outlet reads only the outlet it stands at", async () => {
    signIn("manager", {}, ["void_bill", "void_settlement"]);
    const readX = stubX();
    const ui = await mount(ManagerDashboard);
    expect(readX).toHaveBeenCalledTimes(1);
    expect(readX).toHaveBeenCalledWith("rest");
    expect(ui.text()).toContain(`1 of 1 register reporting`);
  });

  it("without X reports reads no register, draws no sales and no outage", async () => {
    signIn("manager", { x_report: null });
    const readX = stubX(true);
    const ui = await mount(ManagerDashboard);
    expect(readX).not.toHaveBeenCalled();
    expect(ui.kpis()).not.toContain("Billed across open sessions");
    expect(ui.kpis()).toContain("Stock at the counters");
    expect(ui.text()).not.toContain("Session sales");
    expect(ui.alerts().some((a) => a.includes("OUTAGE"))).toBe(false);
  });

  it("without Bills draws no sales card and no bill in the recent activity", async () => {
    signIn("manager", { billing: null });
    stubX();
    const ui = await mount(ManagerDashboard);
    expect(ui.kpis()).not.toContain("Billed across open sessions");
    expect(ui.text()).not.toContain("Session sales");
    const kinds = [...ui.host.querySelectorAll("select")].flatMap((s) => [...s.options].map((o) => o.value));
    expect(kinds).not.toContain("Bills");
    expect(ui.text()).not.toMatch(/Bill [A-Z]+\//);
  });

  it("draws no link to Approvals, Prices or Items & stock for a role that cannot open them", async () => {
    signIn("manager", { approvals: null, prices: null, items_stock: null });
    stubX();
    const ui = await mount(ManagerDashboard);
    expect(ui.has("Open approvals")).toBe(false);
    expect(ui.has("Review now")).toBe(false);
    expect(ui.has("Full approvals screen")).toBe(false);
    expect(ui.has("Prices")).toBe(false);
    expect(ui.has("See transfers")).toBe(false);
  });
});

describe("the store's report library", () => {
  it("leaves the stock ledger out, and never reads it, for a role without Stock ledger", async () => {
    signIn("store", { stock_ledger: null });
    const readStockLedger = vi.fn(async () => []);
    act(() => { useApp.setState({ readStockLedger }); });
    const ui = await mount(StoreReports);
    expect(ui.has("Central store stock ledger")).toBe(false);
    expect(readStockLedger).not.toHaveBeenCalled();
  });

  it("offers it to a role that holds it", async () => {
    signIn("store");
    const ui = await mount(StoreReports);
    expect(ui.has("Central store stock ledger")).toBe(true);
  });
});
