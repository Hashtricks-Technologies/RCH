import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import AdminDashboard from "../pages/AdminDashboard";
import { refetch } from "../api/refetch";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import type { AdminLocation, AdminQrCode, OrderHours } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * The super admin's QR codes tab: the outlet picker (open outlets from the admin's own location
 * list, a closed one greyed with a note), the codes table - create, rename, change mode,
 * deactivate, regenerate behind a second press, the poster and the link - and each outlet's
 * ordering hours. Every sentence toasted is the server's; the rules are the API's to test.
 */

const poster = vi.hoisted(() => ({ calls: [] as unknown[], fail: false }));
vi.mock("../lib/qrPoster", async (orig) => ({
  ...(await orig<typeof import("../lib/qrPoster")>()),
  downloadQrPoster: (o: unknown) => {
    poster.calls.push(o);
    return poster.fail ? Promise.reject(new Error("no")) : Promise.resolve();
  },
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn();
type Stubs = Record<string, (init: RequestInit) => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make ? make(init) : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const hit = (at: string) =>
  fetchMock.mock.calls.filter(([u, init]) => `${(init as RequestInit).method} ${String(u).split("?")[0]}` === at);
const bodyOf = (at: string, n = 0) => JSON.parse(String((hit(at)[n][1] as RequestInit).body)) as unknown;

const tick = () => act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });

const loc = (over: Partial<AdminLocation>): AdminLocation => ({
  key: "coffee", n: "Coffee Shop", c: "OT-CS", type: "Outlet", floor: "Ground", cc: "CC-COF", active: true, staff: 1, ...over,
});
const COFFEE = loc({});
const KIOSK = loc({ key: "kiosk", n: "Snack Kiosk", c: "OT-GK", active: false, staff: 0 });
const STORE_ROW = loc({ key: "store", n: "Central Store", c: "WH-CS", type: "Store" });

const code = (over: Partial<AdminQrCode>): AdminQrCode => ({
  id: "QR-001", loc: "coffee", label: "Table 4", mode: "pickup", token: "tok_AAAAAAAAAAAAAAAAAAAA",
  active: true, createdAt: "2026-09-20T04:10:00.000Z", ...over,
});
const T4 = code({});
const WARD = code({ id: "QR-002", label: "Ward 3B", mode: "deliver", token: "tok_BBBBBBBBBBBBBBBBBBBB", createdAt: "2026-09-21T05:00:00.000Z", rotatedAt: "2026-09-22T06:30:00.000Z" });
const OFF = code({ id: "QR-003", label: "Lobby", active: false, token: "tok_CCCCCCCCCCCCCCCCCCCC" });
const K1 = code({ id: "QR-004", loc: "kiosk", label: "Kiosk front", token: "tok_DDDDDDDDDDDDDDDDDDDD" });
const HOURS: OrderHours[] = [{ loc: "coffee", days: [{ dow: 1, opens: "08:00", closes: "20:00" }, { dow: 0, opens: "10:00", closes: "14:00" }] }];

/** What `GET /admin/qr-codes` answers now - a write's stub puts its row here, so the read-back
 *  the write's `changed` triggers sees it, as the server's would. */
let served: AdminQrCode[] = [];
let servedHours: OrderHours[] = [];
const ok = (result: AdminQrCode, message: string) => () => {
  served = [...served.filter((c) => c.id !== result.id), result];
  return json({ result, changed: ["qrCodes"], message });
};

/** Everything the dashboard reads as it opens, so no stray failure toast lands over the tab. */
const base = (codes: AdminQrCode[] = [T4, WARD, OFF, K1], hours: OrderHours[] = HOURS): Stubs => {
  served = codes; servedHours = hours;
  return {
  "GET /api/v1/admin/users": () => json([]),
  "GET /api/v1/admin/actions": () => json([]),
  "GET /api/v1/admin/support/tickets": () => json([]),
  "GET /api/v1/admin/locations": () => json([STORE_ROW, KIOSK, COFFEE]),
  "GET /api/v1/admin/payers": () => json([]),
  "GET /api/v1/admin/roles": () => json([]),
  "GET /api/v1/admin/qr-codes": () => json({ codes: served, hours: servedHours }),
  };
};

async function mountTab() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MemoryRouter, null, createElement(AdminDashboard))); });
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "QR codes");
  expect(tab, "no QR codes tab").toBeTruthy();
  await act(async () => { tab!.click(); });
  await tick();
  const body = () => host.querySelector(".adm-body")!;
  const buttons = (scope: ParentNode, label: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].filter((b) => (b.textContent ?? "").trim() === label);
  return {
    host,
    tabs: () => [...host.querySelectorAll('[role="tab"]')].map((b) => b.textContent),
    text: () => body().textContent ?? "",
    row: (needle: string) => [...body().querySelectorAll("tr")].find((tr) =>
      tr.textContent?.includes(needle)
      || [...tr.querySelectorAll<HTMLInputElement>("input")].some((el) => el.value.includes(needle)))!,
    button: (label: string, scope: ParentNode = body()) => buttons(scope, label)[0],
    field: (label: string) => {
      const l = [...body().querySelectorAll("label")].find((x) => (x.textContent ?? "").trim() === label)!;
      return body().querySelector<HTMLInputElement & HTMLSelectElement>(`#${CSS.escape(l.htmlFor)}`)!;
    },
    byLabel: <T extends Element>(label: string) => body().querySelector<T>(`[aria-label="${label}"]`)!,
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Page = Awaited<ReturnType<typeof mountTab>>;

const press = async (b: HTMLButtonElement | undefined) => {
  expect(b, "no such button").toBeTruthy();
  await act(async () => { b!.click(); });
  await tick();
};
const setValue = async (el: HTMLInputElement | HTMLSelectElement, v: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
};

let page: Page | undefined;
beforeEach(() => {
  resetStore();
  poster.calls.length = 0; poster.fail = false;
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  act(() => {
    as("manager");
    setAccessToken("admin-tok");
    useApp.setState({ user: { ...S().user!, admin: true } });
  });
});
afterEach(() => { page?.unmount(); page = undefined; vi.unstubAllGlobals(); setAccessToken(null); });

describe("the QR codes tab", () => {
  it("sits after Outlets, and lists the first open outlet's codes - active first, the others' kept off", async () => {
    serve(base());
    page = await mountTab();
    expect(page.tabs().slice(0, 4)).toEqual(["Accounts", "Roles", "Outlets", "QR codes"]);
    expect(hit("GET /api/v1/admin/qr-codes").length).toBeGreaterThan(0);
    const rows = [...page.host.querySelectorAll(".adm-body tbody tr")].map((tr) => tr.textContent ?? "");
    const codeRows = rows.filter((r) => r.includes("QR-00"));
    expect(codeRows).toHaveLength(3);
    expect(codeRows[0]).toContain("Ward 3B");               // newest active first
    expect(codeRows[0]).toContain("Deliver to this spot");
    expect(codeRows[0]).toContain("22-Sep-2026 12:00");      // rotated, in IST
    expect(codeRows[1]).toContain("Table 4");
    expect(codeRows[1]).toContain("Pickup");
    expect(codeRows[1]).toContain("20-Sep-2026 09:40");      // created, in IST
    expect(codeRows[1]).toContain("Never");
    expect(codeRows[2]).toContain("Lobby");
    expect(codeRows[2]).toContain("Off");
    expect(page.text()).not.toContain("Kiosk front");
    // The picker is outlets alone, the open one first and the closed one labelled.
    const opts = [...page.byLabel<HTMLSelectElement>("Outlet").options].map((o) => o.value);
    expect(opts).toEqual(["Coffee Shop", "Snack Kiosk (closed)"]);
  });

  it("greys a closed outlet's codes and says why", async () => {
    serve(base());
    page = await mountTab();
    await setValue(page.byLabel<HTMLSelectElement>("Outlet"), "Snack Kiosk (closed)");
    expect(page.text()).toContain("Snack Kiosk is closed - its codes take no orders");
    expect(page.text()).toContain("Kiosk front");
    expect(page.host.querySelector(".qr-closed")).toBeTruthy();
  });

  it("creates a code with its label and mode, toasts the server's sentence and clears the label", async () => {
    const NEW = code({ id: "QR-005", label: "Bed 12", mode: "deliver", token: "tok_EEEEEEEEEEEEEEEEEEEE" });
    serve({ ...base(), "POST /api/v1/admin/qr-codes": ok(NEW, "Created QR-005 (Bed 12) at Coffee Shop.") });
    page = await mountTab();
    await setValue(page.field("Label"), "  Bed 12 ");
    await setValue(page.field("Mode"), "deliver");
    await press(page.button("Create code"));
    expect(bodyOf("POST /api/v1/admin/qr-codes")).toEqual({ loc: "coffee", label: "Bed 12", mode: "deliver" });
    expect(S().toast).toBe("Created QR-005 (Bed 12) at Coffee Shop.");
    expect(page.field("Label").value).toBe("");
    expect(S().adminQrCodes.some((c) => c.id === "QR-005")).toBe(true);
  });

  it("refuses a blank label without sending, and keeps what was typed on a refusal", async () => {
    serve({
      ...base(),
      "POST /api/v1/admin/qr-codes": () => json({ error: { code: "conflict", message: "Coffee Shop already has a code called Table 4." } }, 409),
    });
    page = await mountTab();
    await press(page.button("Create code"));
    expect(hit("POST /api/v1/admin/qr-codes")).toHaveLength(0);
    expect(S().toast).toContain("Give the code a label");
    await setValue(page.field("Label"), "Table 4");
    await press(page.button("Create code"));
    expect(S().toast).toBe("Coffee Shop already has a code called Table 4.");
    expect(page.field("Label").value).toBe("Table 4");
  });

  it("renames and changes mode in one patch that carries only what changed", async () => {
    serve({ ...base(), "PATCH /api/v1/admin/qr-codes/QR-001": ok({ ...T4, label: "Table 5", mode: "deliver" }, "QR-001 is now Table 5, delivered.") });
    page = await mountTab();
    await press(page.button("Edit", page.row("QR-001")));
    await setValue(page.byLabel<HTMLInputElement>("Label for QR-001"), "Table 5");
    await setValue(page.byLabel<HTMLSelectElement>("Mode for QR-001"), "deliver");
    await press(page.button("Save", page.row("QR-001")));
    expect(bodyOf("PATCH /api/v1/admin/qr-codes/QR-001")).toEqual({ label: "Table 5", mode: "deliver" });
    expect(S().toast).toBe("QR-001 is now Table 5, delivered.");
    expect(page.row("QR-001").textContent).toContain("Table 5");
  });

  it("closes an edit that changed nothing without sending it, and Cancel drops the edit", async () => {
    serve(base());
    page = await mountTab();
    await press(page.button("Edit", page.row("QR-001")));
    await press(page.button("Save", page.row("QR-001")));
    expect(hit("PATCH /api/v1/admin/qr-codes/QR-001")).toHaveLength(0);
    await press(page.button("Edit", page.row("QR-001")));
    await setValue(page.byLabel<HTMLInputElement>("Label for QR-001"), "Nope");
    await press(page.button("Cancel", page.row("QR-001")));
    expect(page.row("QR-001").textContent).toContain("Table 4");
  });

  it("deactivates and reactivates with the one patch, each toasting the server's words", async () => {
    serve({
      ...base(),
      "PATCH /api/v1/admin/qr-codes/QR-001": ok({ ...T4, active: false }, "Table 4 takes no more orders."),
      "PATCH /api/v1/admin/qr-codes/QR-003": ok({ ...OFF, active: true }, "Lobby takes orders again."),
    });
    page = await mountTab();
    await press(page.button("Deactivate", page.row("QR-001")));
    expect(bodyOf("PATCH /api/v1/admin/qr-codes/QR-001")).toEqual({ active: false });
    expect(S().toast).toBe("Table 4 takes no more orders.");
    await press(page.button("Reactivate", page.row("QR-003")));
    expect(bodyOf("PATCH /api/v1/admin/qr-codes/QR-003")).toEqual({ active: true });
    expect(S().toast).toBe("Lobby takes orders again.");
  });

  it("regenerates only on the second press, and Keep code backs out", async () => {
    serve({
      ...base(),
      "POST /api/v1/admin/qr-codes/QR-001/regenerate": ok({ ...T4, token: "tok_ZZZZZZZZZZZZZZZZZZZZ", rotatedAt: "2026-09-24T03:00:00.000Z" }, "Table 4 has a new code - print its poster again."),
    });
    page = await mountTab();
    await press(page.button("Regenerate", page.row("QR-001")));
    expect(hit("POST /api/v1/admin/qr-codes/QR-001/regenerate")).toHaveLength(0);
    await press(page.button("Keep code", page.row("QR-001")));
    expect(page.button("Regenerate Table 4")).toBeUndefined();
    await press(page.button("Regenerate", page.row("QR-001")));
    await press(page.button("Regenerate Table 4"));
    expect(hit("POST /api/v1/admin/qr-codes/QR-001/regenerate")).toHaveLength(1);
    expect(S().toast).toBe("Table 4 has a new code - print its poster again.");
    expect(S().adminQrCodes.find((c) => c.id === "QR-001")!.token).toBe("tok_ZZZZZZZZZZZZZZZZZZZZ");
  });

  it("toasts a refused regenerate verbatim and keeps the second press up", async () => {
    serve({
      ...base(),
      "POST /api/v1/admin/qr-codes/QR-001/regenerate": () => json({ error: { code: "rule", message: "Table 4 is switched off - reactivate it first." } }, 422),
    });
    page = await mountTab();
    await press(page.button("Regenerate", page.row("QR-001")));
    await press(page.button("Regenerate Table 4"));
    expect(S().toast).toBe("Table 4 is switched off - reactivate it first.");
    expect(page.button("Regenerate Table 4")).toBeTruthy();
  });

  it("builds the poster with the outlet, the label, the mode and the ordering link", async () => {
    serve(base());
    page = await mountTab();
    await press(page.button("Download poster", page.row("QR-002")));
    expect(poster.calls).toEqual([{ outletName: "Coffee Shop", label: "Ward 3B", mode: "deliver", url: `${window.location.origin}/order/tok_BBBBBBBBBBBBBBBBBBBB` }]);
    // A switched-off code has no poster to print.
    expect(page.button("Download poster", page.row("QR-003")).disabled).toBe(true);
    poster.fail = true;
    await press(page.button("Download poster", page.row("QR-001")));
    expect(S().toast).toBe("Could not build the poster for Table 4 - try again.");
  });

  it("warns that posters printed from a local address point at it, and still downloads", async () => {
    serve(base());
    page = await mountTab();
    // jsdom serves the suite from http://localhost - exactly the address a poster must not carry.
    const warn = [...document.querySelectorAll(".al")].find((a) => a.textContent?.includes("Posters printed from this address"));
    expect(warn?.textContent).toContain(`Posters printed from this address will point to ${window.location.origin} - print them from the live site.`);
    await press(page.button("Download poster", page.row("QR-002")));
    expect(poster.calls).toHaveLength(1);
  });

  it("copies the ordering link, and says so when the browser will not", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    serve(base());
    page = await mountTab();
    await press(page.button("Copy link", page.row("QR-001")));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/order/tok_AAAAAAAAAAAAAAAAAAAA`);
    expect(S().toast).toBe("Copied the ordering link for Table 4.");
    writeText.mockImplementation(() => Promise.reject(new Error("denied")));
    await press(page.button("Copy link", page.row("QR-001")));
    expect(S().toast).toContain("Could not copy the link for Table 4");
  });

  it("draws the week Monday first from the stored hours, a missing day closed", async () => {
    serve(base());
    page = await mountTab();
    expect(page.byLabel<HTMLInputElement>("Monday opens").value).toBe("08:00");
    expect(page.byLabel<HTMLInputElement>("Monday closes").value).toBe("20:00");
    expect(page.byLabel<HTMLInputElement>("Sunday opens").value).toBe("10:00");
    expect(page.byLabel("Tuesday opens")).toBeNull();
    expect(page.byLabel<HTMLButtonElement>("Take QR orders on Tuesday").getAttribute("aria-pressed")).toBe("false");
    const days = [...page.host.querySelectorAll(".adm-body tbody tr b")].map((b) => b.textContent);
    expect(days.filter((d) => d?.endsWith("day"))).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  });

  it("saves the whole week - closed days left out - and toasts the server's sentence", async () => {
    serve({
      ...base(),
      "PUT /api/v1/admin/outlets/coffee/order-hours": (init) => {
        const result = { loc: "coffee", ...(JSON.parse(String(init.body)) as Omit<OrderHours, "loc">) };
        servedHours = [result];
        return json({ result, changed: ["qrCodes"], message: "Coffee Shop takes QR orders on 2 days a week." });
      },
    });
    page = await mountTab();
    await setValue(page.byLabel<HTMLInputElement>("Monday opens"), "07:30");
    await press(page.byLabel<HTMLButtonElement>("Take QR orders on Tuesday"));
    await press(page.byLabel<HTMLButtonElement>("Take QR orders on Sunday"));
    await press(page.button("Save hours"));
    expect(bodyOf("PUT /api/v1/admin/outlets/coffee/order-hours")).toEqual({
      days: [{ dow: 1, opens: "07:30", closes: "20:00" }, { dow: 2, opens: "08:00", closes: "20:00" }],
    });
    expect(S().toast).toBe("Coffee Shop takes QR orders on 2 days a week.");
    expect(S().adminOrderHours.find((h) => h.loc === "coffee")!.days.map((d) => d.dow)).toEqual([1, 2]);
    // The editor starts again from what the server stored: Sunday is closed now.
    expect(page.byLabel("Sunday opens")).toBeNull();
    expect(page.byLabel<HTMLInputElement>("Monday opens").value).toBe("07:30");
  });

  it("refuses a window that closes before it opens, or a blank time, without sending", async () => {
    serve(base());
    page = await mountTab();
    await setValue(page.byLabel<HTMLInputElement>("Monday closes"), "07:00");
    await press(page.button("Save hours"));
    expect(S().toast).toBe("Monday's window must close after it opens - a window cannot run past midnight.");
    await setValue(page.byLabel<HTMLInputElement>("Monday closes"), "");
    await press(page.button("Save hours"));
    expect(S().toast).toBe("Set both times for Monday, or mark it closed.");
    expect(hit("PUT /api/v1/admin/outlets/coffee/order-hours")).toHaveLength(0);
  });

  it("says so when there is no outlet to place a code in", async () => {
    serve({ ...base([], []), "GET /api/v1/admin/locations": () => json([STORE_ROW]) });
    page = await mountTab();
    expect(page.text()).toContain("Open an outlet on the Outlets tab");
  });
});

describe("the QR slice on the wire", () => {
  it("toasts an outage on the first read", async () => {
    serve({});
    await act(async () => { await S().loadAdminQrCodes(); });
    expect(S().toast).toContain("no stub for GET");
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("offline")));
    await act(async () => { await S().loadAdminQrCodes(); });
    expect(S().toast).toBe("Could not read the QR codes - check the connection and try again.");
  });

  it("falls back to its own sentence for each write when the network is down", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("offline")));
    expect(await S().createQrCode({ loc: "coffee", label: "X", mode: "pickup" })).toBeNull();
    expect(S().toast).toBe("Could not create the QR code - check the connection and try again.");
    expect(await S().updateQrCode("QR-001", { active: false })).toBe(false);
    expect(S().toast).toBe("Could not save the QR code - check the connection and try again.");
    expect(await S().regenerateQrCode("QR-001")).toBe(false);
    expect(S().toast).toBe("Could not regenerate the QR code - check the connection and try again.");
    expect(await S().setOrderHours("coffee", [])).toBe(false);
    expect(S().toast).toBe("Could not save the ordering hours - check the connection and try again.");
  });

  it("reads the codes back on a qrCodes notice for the super admin, and nothing for an operator", async () => {
    serve({ "GET /api/v1/admin/qr-codes": () => json({ codes: [T4], hours: HOURS }) });
    await act(async () => { await refetch(["qrCodes"]); });
    expect(hit("GET /api/v1/admin/qr-codes")).toHaveLength(1);
    expect(S().adminQrCodes).toEqual([T4]);
    expect(S().adminOrderHours).toEqual(HOURS);

    act(() => { as("counter"); });
    fetchMock.mockClear();
    await act(async () => { await refetch(["qrCodes"]); });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
