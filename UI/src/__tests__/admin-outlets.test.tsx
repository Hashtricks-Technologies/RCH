import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import AdminOutlets from "../pages/AdminOutlets";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import type { AdminLocation } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * The Outlets tab: opens, edits, closes and reopens an outlet, and previews the key a new one
 * will get. Every rule enforced here is the server's - this only repeats its sentences and keeps
 * the store and the kitchen off the list, since neither is opened or closed from this page.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn();
type Stubs = Record<string, () => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make ? make() : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const hit = (at: string) =>
  fetchMock.mock.calls.filter(([u, init]) => `${(init as RequestInit).method} ${String(u).split("?")[0]}` === at);

const tick = () => act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });

async function mountPage() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(AdminOutlets))); });
  await tick();                                     // the list and the feed land
  const buttons = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label));
  return {
    text: () => host.textContent ?? "",
    // A row in edit mode turns its cells into inputs, so the code that names it (the way an
    // emp id never turns editable on the account page) sits in a value, not in the row's text -
    // this checks both, so `row()` finds a row before, during and after an edit.
    row: (needle: string) => [...host.querySelectorAll("tr")].find((tr) =>
      tr.textContent?.includes(needle)
      || [...tr.querySelectorAll<HTMLInputElement>("input,select")].some((el) => el.value.includes(needle)))!,
    field: (label: string) => {
      const l = [...host.querySelectorAll("label")].find((x) => (x.textContent ?? "").trim() === label)!;
      return host.querySelector<HTMLInputElement>(`#${CSS.escape(l.htmlFor)}`)!;
    },
    button: (label: string, scope: ParentNode = host) => buttons(scope, label)[0],
    buttons: (label: string, scope: ParentNode = host) => buttons(scope, label),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Page = Awaited<ReturnType<typeof mountPage>>;

const press = async (b: HTMLButtonElement | undefined) => {
  expect(b, "no such button").toBeTruthy();
  await act(async () => { b!.click(); await new Promise((r) => { setTimeout(r, 0); }); });
};

const typeInto = async (el: HTMLInputElement, v: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

let page: Page | undefined;
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
afterEach(() => { page?.unmount(); page = undefined; vi.unstubAllGlobals(); setAccessToken(null); });

const row = (over: Partial<AdminLocation>): AdminLocation => ({
  key: "rest", n: "Restaurant", c: "OT-R1", type: "Outlet", floor: "Floor 1", cc: "CC-RST", active: true, staff: 1, ...over,
});
const STORE_ROW = row({ key: "store", n: "Central Store", c: "WH-CS", type: "Store", floor: "Basement", cc: "CC-STO", staff: 2 });
const REST = row({});
const KIOSK = row({ key: "kiosk", n: "Snack Kiosk", c: "OT-GK", floor: "Ground", cc: "CC-KSK", active: false, staff: 0 });
const ok = (result: AdminLocation, message: string) => () => json({ result, changed: ["outlets", "locations"], message });

describe("the Outlets tab", () => {
  it("lists outlets only - open ones first - with their code, staff and status", async () => {
    serve({ "GET /api/v1/admin/locations": () => json([STORE_ROW, KIOSK, REST]), "GET /api/v1/admin/actions": () => json([]) });
    page = await mountPage();
    const rows = [...document.querySelectorAll("tbody tr")].map((tr) => tr.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Restaurant"); expect(rows[0]).toContain("OT-R1"); expect(rows[0]).toContain("Open");
    expect(rows[1]).toContain("Snack Kiosk"); expect(rows[1]).toContain("Closed");
    expect(page.text()).not.toContain("Central Store");
    expect(hit("GET /api/v1/admin/actions")[0][0]).toContain("kind=outlets");
  });
  it("previews the key a new outlet will get, opens it, and clears the form", async () => {
    const JUICE = row({ key: "juice-bar", n: "Juice Bar", c: "OT-JB", floor: "Ground", cc: "CC-JB", staff: 0 });
    serve({
      "GET /api/v1/admin/locations": () => json([REST]), "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/outlets": ok(JUICE, "Opened Juice Bar (OT-JB)."),
    });
    page = await mountPage();
    await typeInto(page.field("Name"), "Juice Bar");
    await typeInto(page.field("Code"), "ot-jb");
    await typeInto(page.field("Floor"), "Ground");
    await typeInto(page.field("Cost centre"), "CC-JB");
    expect(page.text()).toContain("juice-bar");
    await press(page.button("Open outlet"));
    const [, init] = hit("POST /api/v1/admin/outlets")[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: "Juice Bar", code: "ot-jb", floor: "Ground", cc: "CC-JB" });
    expect(page.field("Name").value).toBe("");
  });
  it("keeps the form as typed when the server refuses", async () => {
    serve({
      "GET /api/v1/admin/locations": () => json([REST]), "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/outlets": () => json({ error: { code: "conflict", message: "Refused - a location named Restaurant already exists" } }, 409),
    });
    page = await mountPage();
    await typeInto(page.field("Name"), "Restaurant");
    await typeInto(page.field("Code"), "OT-R9");
    await typeInto(page.field("Floor"), "G");
    await typeInto(page.field("Cost centre"), "CC");
    await press(page.button("Open outlet"));
    expect(page.field("Name").value).toBe("Restaurant");
  });
  it("edits a row in place and sends only what changed", async () => {
    serve({
      "GET /api/v1/admin/locations": () => json([REST]), "GET /api/v1/admin/actions": () => json([]),
      "PATCH /api/v1/admin/outlets/rest": ok({ ...REST, n: "Main Restaurant" }, "Saved Main Restaurant."),
    });
    page = await mountPage();
    await press(page.button("Edit", page.row("OT-R1")));
    await typeInto(page.row("OT-R1").querySelector<HTMLInputElement>('input[aria-label="Name for OT-R1"]')!, "Main Restaurant");
    await press(page.button("Save", page.row("OT-R1")));
    const [, init] = hit("PATCH /api/v1/admin/outlets/rest")[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: "Main Restaurant" });
  });
  it("closes behind a second press, and reopens in one", async () => {
    serve({
      "GET /api/v1/admin/locations": () => json([REST, KIOSK]), "GET /api/v1/admin/actions": () => json([]),
      "POST /api/v1/admin/outlets/rest/close": ok({ ...REST, active: false }, "Closed Restaurant. Its bills and reports are kept."),
      "POST /api/v1/admin/outlets/kiosk/reopen": ok({ ...KIOSK, active: true }, "Reopened Snack Kiosk."),
    });
    page = await mountPage();
    await press(page.button("Close", page.row("OT-R1")));
    expect(hit("POST /api/v1/admin/outlets/rest/close")).toHaveLength(0);
    await press(page.button("Close Restaurant", page.row("OT-R1")));
    expect(hit("POST /api/v1/admin/outlets/rest/close")).toHaveLength(1);
    await press(page.button("Reopen", page.row("OT-GK")));
    expect(hit("POST /api/v1/admin/outlets/kiosk/reopen")).toHaveLength(1);
  });
});
