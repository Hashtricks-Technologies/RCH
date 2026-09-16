import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AUDIT_GROUPS, auditLabelOf } from "@rch/contract";
import { istDate } from "@rch/domain";
import AdminDashboard from "../pages/AdminDashboard";
import { refetch } from "../api/refetch";
import { setAccessToken } from "../api/session";
import { auditDayRange } from "../lib/audit";
import { useApp } from "../store";
import type { AdminUser, AuditCounts, AuditEntry, AuditPage, AuditRow } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * The super admin's third tab, driven against a stubbed audit service. It covers what the tab
 * lists and counts, the query each filter sends, "Load more", the new-events pill a change notice
 * raises, the entry drawer's before -> after and its two links, the export, and the two ways a
 * read comes back with nothing to show.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn();
type Stubs = Record<string, (url: URL) => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const url = new URL(String(u), "http://rch.test");
    const make = stubs[`${init.method} ${url.pathname}`];
    return Promise.resolve(make ? make(url) : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const LOG = "/api/v1/admin/audit";
/** Every query the list path was read with, in order. */
const queries = () =>
  fetchMock.mock.calls
    .map(([u]) => new URL(String(u), "http://rch.test"))
    .filter((u) => u.pathname === LOG)
    .map((u) => Object.fromEntries(u.searchParams));

const KAVITHA: AdminUser = {
  id: "u1", emp: "RC-4471", n: "Kavitha Raman", e: "kavitha.r@royalcare.in", ph: "", r: "counter",
  rl: "Counter Operator", loc: "coffee", col: "#B45309", active: true, mustChangePassword: false, admin: false,
};
const MANAGER = { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" };
const COUNTS: AuditCounts = { events: 3, people: 2, refused: 1, failedSignIns: 1 };
const row = (id: number, over: Partial<AuditRow> = {}): AuditRow => ({
  id, at: "2026-09-14T04:12:09.000Z", actor: MANAGER, action: "savePrice", target: "A:juice", targetLoc: "",
  outcome: "done", status: 200, message: `Price saved (event ${id})`, ip: "10.0.0.7", requestId: `req-${id}`, ...over,
});
const FAILED_SIGN_IN = row(42, {
  at: "2026-09-14T03:00:00.000Z", actor: { id: null, emp: "RC-9999", name: "", role: "", loc: "" },
  action: "login", target: "", outcome: "refused", status: 401, message: "Wrong employee id or password",
});
const page = (rows: AuditRow[], next: number | null = null, counts: AuditCounts = COUNTS): AuditPage => ({ rows, next, counts });
const FIRST = page([row(43), FAILED_SIGN_IN], 42);

/** The reads the page makes as it opens (the accounts tab, the desk count, the outlet list, the
 *  payer register, the Person picker), so no stray failure toast lands over the audit log. */
const BASE: Stubs = {
  "GET /api/v1/admin/users": () => json([KAVITHA]),
  "GET /api/v1/admin/actions": () => json([]),
  "GET /api/v1/admin/support/tickets": () => json([]),
  "GET /api/v1/admin/locations": () => json([]),
  "GET /api/v1/admin/payers": () => json([]),
};

const tick = (ms = 0) => act(async () => { await new Promise((r) => { setTimeout(r, ms); }); });

async function openAuditTab() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(AdminDashboard))); });
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Audit log");
  expect(tab, "no Audit log tab").toBeTruthy();
  await act(async () => { tab!.click(); });
  await tick();
  const body = () => host.querySelector(".adm-body")!;
  return {
    host,
    text: () => body().textContent ?? "",
    /** The table's rows, not the one that carries its empty state. */
    rows: () => [...body().querySelectorAll<HTMLTableRowElement>("tbody tr")].filter((tr) => !tr.querySelector(".empty")),
    drawer: () => host.querySelector<HTMLElement>("aside.drawer"),
    search: () => host.querySelector<HTMLInputElement>(".tbar .sfield input")!,
    button: (label: string, scope: ParentNode = host) =>
      [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === label),
    press: async (el: HTMLElement | undefined) => {
      expect(el, "no such control").toBeTruthy();
      await act(async () => { el!.click(); });
      await tick();
    },
    choose: async (label: string, value: string) => {
      const sel = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
      await act(async () => { sel.value = value; sel.dispatchEvent(new Event("change", { bubbles: true })); });
      await tick();
    },
    type: async (el: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Ui = Awaited<ReturnType<typeof openAuditTab>>;

let ui: Ui | undefined;
beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  act(() => {
    as("manager");
    setAccessToken("admin-tok");
    useApp.setState({ user: { ...S().user!, admin: true } });
  });
});
afterEach(() => { ui?.unmount(); ui = undefined; vi.unstubAllGlobals(); setAccessToken(null); });

describe("the audit log tab", () => {
  it("lists today's events, newest first, with who, what and the outcome, and counts the whole filter", async () => {
    serve({ ...BASE, "GET /api/v1/admin/audit": () => json(FIRST) });
    ui = await openAuditTab();
    const today = istDate(new Date());
    expect(queries()).toEqual([{ from: today, to: today }]);
    // The page's sentence is PageHead's tip. Its bubble stays in the DOM while closed, so the text is there.
    expect(ui.host.querySelector(".pgh [role=tooltip]")?.textContent).toBe("Every change and sign-in, with who made it and when.");

    const rows = ui.rows();
    expect(rows).toHaveLength(2);
    // 04:12:09 UTC is 09:42:09 at the hospital.
    expect(rows[0].textContent).toContain("14-Sep-2026");
    expect(rows[0].textContent).toContain("09:42:09");
    expect(rows[0].textContent).toContain("RC-3120 · Ramesh Kumar · Outlet Manager");
    expect(rows[0].textContent).toContain("Restaurant");
    expect(rows[0].textContent).toContain(auditLabelOf("savePrice", "done").label);
    expect(rows[0].textContent).toContain("A:juice");
    expect(rows[0].textContent).toContain("Done");
    expect(rows[0].textContent).toContain("Price saved (event 43)");
    expect(rows[1].textContent).toContain("Failed sign-in");
    expect(rows[1].textContent).toContain("Refused");

    const kpis = [...ui.host.querySelectorAll(".kpi")].map((k) => `${k.querySelector(".kl")!.textContent}=${k.querySelector(".kv")!.textContent}`);
    expect(kpis).toEqual(["Events=3", "People=2", "Refused=1", "Failed sign-ins=1"]);
    expect(ui.text()).toContain("Showing 2 of 3");
  });

  it("sends each filter in the query string, and the search only once typing pauses", async () => {
    serve({ ...BASE, "GET /api/v1/admin/audit": () => json(FIRST) });
    ui = await openAuditTab();
    const today = istDate(new Date());
    const last = () => queries().at(-1);

    await ui.choose("Area", AUDIT_GROUPS.sales);
    expect(last()).toEqual({ from: today, to: today, group: "sales" });
    await ui.press(ui.button("Refused"));
    expect(last()).toEqual({ from: today, to: today, group: "sales", outcome: "refused" });
    await ui.choose("Role", "Store Keeper");
    await ui.choose("Location", "Coffee Shop");
    await ui.choose("Person", "RC-4471 · Kavitha Raman");
    expect(last()).toEqual({
      from: today, to: today, group: "sales", outcome: "refused", role: "Store Keeper", loc: "coffee", actor: "u1",
    });

    await ui.press(ui.button("7 days"));
    const week = auditDayRange("7d", { from: "", to: "" });
    expect(last()).toMatchObject(week);

    const reads = queries().length;
    await ui.type(ui.search(), "CF/11");
    expect(queries()).toHaveLength(reads);              // not yet: the box waits for the typing to pause
    await tick(350);
    expect(queries()).toHaveLength(reads + 1);
    expect(last()).toMatchObject({ q: "CF/11", actor: "u1" });

    // Custom opens on the days already shown, and a typed day is sent as it stands.
    await ui.press(ui.button("Custom"));
    const from = ui.host.querySelector<HTMLInputElement>('input[aria-label="From"]')!;
    expect(from.value).toBe(week.from);
    await ui.type(from, "2026-09-01");
    await tick();
    expect(last()).toMatchObject({ from: "2026-09-01", to: week.to });
  });

  it("asks for the next page before the last row it has, and adds it underneath", async () => {
    serve({ ...BASE, "GET /api/v1/admin/audit": (url) => json(url.searchParams.has("before") ? page([row(41)]) : FIRST) });
    ui = await openAuditTab();
    await ui.press(ui.button("Load more"));
    expect(queries().at(-1)).toMatchObject({ before: "42" });
    expect(ui.rows()).toHaveLength(3);
    expect(ui.rows()[2].textContent).toContain("Price saved (event 41)");
    expect(ui.button("Load more")).toBeUndefined();
  });

  it("counts change notices on a pill and leaves the list alone until the pill is pressed", async () => {
    let served = FIRST;
    serve({ ...BASE, "GET /api/v1/admin/audit": () => json(served) });
    ui = await openAuditTab();
    served = page([row(44), ...FIRST.rows], 42, { ...COUNTS, events: 4 });

    const pill = () => ui!.button("New events - show");
    expect(pill()).toBeUndefined();
    await act(async () => { await refetch(["audit"]); await refetch(["audit"]); });
    // No number on it: one notice can carry several events.
    expect(pill()).toBeTruthy();
    expect(S().audit.fresh).toBe(2);
    expect(ui.rows()).toHaveLength(2);
    expect(queries()).toHaveLength(1);

    await ui.press(pill());
    expect(queries()).toHaveLength(2);
    expect(ui.rows()).toHaveLength(3);
    expect(pill()).toBeUndefined();
  });

  it("says the log could not be read on a failure, never that nothing happened, and tries again on request", async () => {
    let up = false;
    serve({ ...BASE, "GET /api/v1/admin/audit": () => (up ? json(FIRST) : json({ error: { code: "internal", message: "boom" } }, 500)) });
    ui = await openAuditTab();
    expect(ui.text()).toContain("Could not read the audit log - check the connection and try again.");
    expect(ui.text()).not.toContain("Nothing recorded");
    expect(S().toast).toBeNull();
    up = true;
    await ui.press(ui.button("Try again"));
    expect(ui.rows()).toHaveLength(2);
  });

  it("calls an empty log nothing recorded, and an empty filtered one nothing matching", async () => {
    serve({ ...BASE, "GET /api/v1/admin/audit": () => json(page([], null, { events: 0, people: 0, refused: 0, failedSignIns: 0 })) });
    ui = await openAuditTab();
    expect(ui.text()).toContain("Nothing recorded in this period");
    await ui.press(ui.button("Refused"));
    expect(ui.text()).toContain("No events match these filters");
  });

  it("exports the filter as a CSV file named for its days", async () => {
    serve({ ...BASE, "GET /api/v1/admin/audit": (url) => json(url.searchParams.get("limit") === "500" ? page(FIRST.rows) : FIRST) });
    const blobs: Blob[] = [];
    const names: string[] = [];
    // jsdom has no object URLs. These stay defined for the rest of this file: the page revokes on a
    // timer that may fire after the test.
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (b: Blob) => { blobs.push(b); return "blob:audit"; } });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      names.push(document.querySelector<HTMLAnchorElement>("a[download]")!.download);
    });
    try {
      ui = await openAuditTab();
      await ui.press(ui.button("Export CSV"));
      for (let i = 0; i < 20 && names.length === 0; i++) await tick(5);
      const today = istDate(new Date());
      expect(queries().at(-1)).toMatchObject({ limit: "500" });
      expect(names).toEqual([`audit-${today}-${today}.csv`]);
      expect(blobs[0].type).toBe("text/csv;charset=utf-8");
      expect(S().toast).toBeNull();
    } finally {
      click.mockRestore();
    }
  });
});

describe("an audit entry", () => {
  const ENTRY: AuditEntry = {
    ...row(43, { action: "patchItem", target: "juice" }),
    method: "PATCH", path: "/items/juice", cause: null,
    request: { params: { it: "juice" }, query: {}, body: { mrp: 45, cost: 30 } },
    before: { mrp: 50, cost: 30, n: "Orange juice" },
    result: { c: "juice", n: "Orange juice", mrp: 45, cost: 30, u: "nos" },
    changed: ["items"],
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  };
  const openEntry = async () => {
    serve({
      ...BASE,
      "GET /api/v1/admin/audit": () => json(page([row(43, { action: "patchItem", target: "juice" })])),
      "GET /api/v1/admin/audit/43": () => json(ENTRY),
    });
    ui = await openAuditTab();
    await ui.press(ui.rows()[0]);
    return ui.drawer()!;
  };

  it("shows where it came from and, before against after, only the fields that changed", async () => {
    const drawer = await openEntry();
    expect(S().drawer).toEqual({ t: "auditEntry", id: "43" });
    expect(drawer.textContent).toContain("Chrome on Windows");
    expect(drawer.textContent).toContain("10.0.0.7");
    expect(drawer.textContent).toContain("req-43");
    expect(drawer.textContent).toContain("PATCH /items/juice");
    const diff = [...drawer.querySelectorAll(".aud-diff tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(diff).toEqual([["mrp", "₹50.00", "₹45.00"]]);
  });

  it("opens everything by the same person, keeping the period, and closes", async () => {
    const drawer = await openEntry();
    await ui!.press(ui!.button("Everything by this person", drawer));
    const today = istDate(new Date());
    expect(S().drawer).toBeNull();
    expect(queries().at(-1)).toEqual({ from: today, to: today, actor: "u2" });
  });

  it("searches for the event's target, and the search box shows it without searching twice", async () => {
    const drawer = await openEntry();
    await ui!.press(ui!.button("Everything on juice", drawer));
    const today = istDate(new Date());
    expect(S().drawer).toBeNull();
    expect(queries().at(-1)).toEqual({ from: today, to: today, q: "juice" });
    expect(ui!.search().value).toBe("juice");
    const reads = queries().length;
    await tick(350);
    expect(queries()).toHaveLength(reads);
  });
});
