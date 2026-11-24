import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import * as FX from "@rch/contract/fixtures";
import { routes } from "@rch/contract";
import { ADMIN_PRESET, DESK_DEFAULTS } from "@rch/domain";
import App from "../App";
import AdminRoles from "../pages/AdminRoles";
import AdminUsers from "../pages/AdminUsers";
import Drawer from "../ui/Drawer";
import { ApiError, call, closeSessionChannel } from "../api/client";
import { startEventStream } from "../api/events";
import { getAccessToken, movedBetween, placeIn, setAccessToken } from "../api/session";
import { homeLabel, LOC } from "../data/master";
import { useApp } from "../store";
import type { AdminRole, AdminUser, User } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * A two-sided role in the browser: the choice after the password, the header's switcher, a tab whose
 * session was moved from another, and the role editor's second matrix.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn();
type Stubs = Record<string, (init: RequestInit) => Response | Promise<Response>>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method ?? "GET"} ${String(u).split("?")[0].replace("/api/v1", "")}`];
    return Promise.resolve(make ? make(init) : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const hits = (at: string) => fetchMock.mock.calls.filter(([u, init]) => `${(init as RequestInit).method ?? "GET"} ${String(u).split("?")[0].replace("/api/v1", "")}` === at);
const sent = (at: string, n = 0) => JSON.parse(String((hits(at)[n][1] as RequestInit).body)) as Record<string, unknown>;

/** An unsigned token the browser can read a place off, as it does the server's. */
const tok = (role: string, loc: string, unplaced = false) =>
  `h.${btoa(JSON.stringify({ role, loc, ...(unplaced ? { unplaced } : {}) })).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.s`;

const OUTLETS = [{ k: "coffee", n: "Coffee Shop", c: "OT-C3" }, { k: "kiosk", n: "Snack Kiosk", c: "OT-GK" }];
const base = FX.USERS.find((u) => u.id === "u1")!;
const asha = (at: "billing" | "inventory" | null, loc = "coffee"): User => ({
  ...base, id: "u20", n: "Asha Admin", rl: "Admin", emp: "RC-4483",
  r: at === "inventory" ? "store" : "counter", loc: at === "inventory" ? "store" : loc,
  perms: at === "inventory" ? ADMIN_PRESET.inventory : ADMIN_PRESET.perms,
  sides: { at, outlets: OUTLETS },
});
const tokenOf = (u: User) => tok(u.r, u.loc, u.sides?.at === null);
const answer = (u: User) => json({ accessToken: tokenOf(u), user: u, mustChangePassword: false, postings: ["coffee"] });
const snapshotOf = (u: User) => json({
  user: u, items: FX.IT, locations: FX.LOC, users: FX.USERS, roster: { staff: [], depts: [], doctors: [] }, terms: { classes: [], payers: [] },
  stock: FX.seedStock, rsv: {}, ovr: {}, prices: FX.PL, priceLists: [], menu: FX.MENU,
  req: [], tkt: [], prq: [], po: [], pord: [], batch: [], bills: [], grn: [], vendors: [], contracts: [], tickets: [], productReqs: [], shopAsks: [],
  sales: [], dayLabels: [], adjustments: [], adjReq: [],
});
/** A server that puts the session where the choice asked. */
let now: User;
const moving: Stubs = {
  "POST /auth/side": (init) => {
    const b = JSON.parse(String(init.body)) as { side: "billing" | "inventory"; loc?: string };
    now = asha(b.side, b.loc);
    return answer(now);
  },
  "GET /snapshot": () => snapshotOf(now),
  "GET /me": () => json({ user: now, mustChangePassword: false }),
  "GET /shifts": () => json([]), "GET /qr-orders": () => json({ orders: [], paused: [] }), "GET /shifts/current": () => json({ shift: null }),
};

function Where() { return createElement("p", { id: "where" }, useLocation().pathname); }
async function mount(el: Parameters<typeof createElement>[0], at = "/pos") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MemoryRouter, { initialEntries: [at] }, createElement(Fragment, null, createElement(el), createElement(Where)))); });
  await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
  const buttons = () => [...host.querySelectorAll("button")];
  return {
    host,
    text: () => host.textContent ?? "",
    where: () => host.querySelector("#where")!.textContent,
    button: (needle: string) => buttons().find((b) => (b.textContent ?? "").includes(needle) || b.getAttribute("aria-label") === needle),
    switcher: () => host.querySelector<HTMLButtonElement>(".sidebtn"),
    items: () => [...host.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")],
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Ui = Awaited<ReturnType<typeof mount>>;
const press = async (b: HTMLElement | null | undefined) => {
  expect(b, "no such button").toBeTruthy();
  await act(async () => { b!.click(); await new Promise((r) => { setTimeout(r, 0); }); });
};
const signIn = (u: User) => { now = u; setAccessToken(tokenOf(u)); useApp.setState({ user: u, auth: "ready", mustChangePassword: false, drawer: null }); };

let ui: Ui | undefined;
beforeEach(() => { resetStore(); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); useApp.setState({ draft: [], tills: {}, toast: null }); });
afterEach(() => { ui?.unmount(); ui = undefined; vi.unstubAllGlobals(); closeSessionChannel(); setAccessToken(null); });

describe("signing in", () => {
  it("waits for a side before it asks for the hospital's data", async () => {
    serve({ "POST /auth/login": () => answer(asha(null)) });
    expect(await S().login("RC-4483", "a-long-password")).toBe(true);
    expect(S().auth).toBe("ready");
    expect(S().user?.sides?.at).toBeNull();
    expect(hits("GET /snapshot")).toHaveLength(0);
  });

  it("asks for a new password first, and only then for a side", async () => {
    signIn(asha(null));
    useApp.setState({ mustChangePassword: true });
    ui = await mount(App);
    expect(ui.text()).toContain("Choose a new password");
    expect(ui.text()).not.toContain("What are you working on?");
  });
});

describe("the choice", () => {
  it("offers Billing and Inventory in place of every page, and Inventory goes straight in", async () => {
    serve(moving);
    signIn(asha(null));
    ui = await mount(App, "/settings");
    expect(ui.text()).toContain("What are you working on?");
    expect(ui.host.querySelector("#app")).toBeNull();
    await press(ui.button("Inventory"));
    expect(sent("POST /auth/side")).toEqual({ side: "inventory" });
    expect(S().user).toMatchObject({ r: "store", loc: "store" });
    expect(getAccessToken()).toBe(tok("store", "store"));
    expect(ui.where()).toBe("/issue");
  });

  it("asks which outlet for Billing, with a way back, and opens that outlet's till", async () => {
    serve(moving);
    signIn(asha(null));
    ui = await mount(App);
    await press(ui.button("Billing"));
    expect(ui.text()).toContain("Which outlet?");
    expect(document.activeElement?.textContent).toContain("Coffee Shop");
    await press(ui.button("Back"));
    expect(ui.text()).toContain("What are you working on?");
    await press(ui.button("Billing"));
    await press(ui.button("Snack Kiosk"));
    expect(sent("POST /auth/side")).toEqual({ side: "billing", loc: "kiosk" });
    expect(S().user?.loc).toBe("kiosk");
    expect(ui.where()).toBe("/pos");
  });

  it("goes straight to the only outlet, and offers no Billing when none is open", async () => {
    serve(moving);
    signIn({ ...asha(null), sides: { at: null, outlets: [OUTLETS[1]] } });
    ui = await mount(App);
    await press(ui.button("Billing"));
    expect(sent("POST /auth/side")).toEqual({ side: "billing", loc: "kiosk" });
    ui.unmount();
    signIn({ ...asha(null), sides: { at: null, outlets: [] } });
    ui = await mount(App);
    expect((ui.button("Billing") as HTMLButtonElement).disabled).toBe(true);
    expect(ui.text()).toContain("No outlet is open to bill at.");
  });

  it("keeps the question up, with the server's sentence, when the place is refused", async () => {
    serve({ "POST /auth/side": () => json({ error: { code: "rule", message: "Snack Kiosk is closed - nothing may be sold there" } }, 422) });
    signIn(asha(null));
    ui = await mount(App);
    await press(ui.button("Billing"));
    await press(ui.button("Snack Kiosk"));
    expect(S().toast).toBe("Snack Kiosk is closed - nothing may be sold there");
    expect(ui.text()).toContain("Which outlet?");
    expect((ui.button("Snack Kiosk") as HTMLButtonElement).disabled).toBe(false);
  });

  it("can be left by signing out", async () => {
    serve({ "POST /auth/logout": () => json({ ok: true }), "GET /auth/directory": () => json([]) });
    signIn(asha(null));
    ui = await mount(App);
    await press(ui.button("Sign out"));
    expect(S().user).toBeNull();
  });
});

describe("the header's switcher", () => {
  it("is not there for an ordinary role", async () => {
    serve(moving);
    as("counter");
    ui = await mount(App);
    expect(ui.host.querySelector("#app")).toBeTruthy();
    expect(ui.switcher()).toBeNull();
  });

  it("names where the session stands, and moves it to another outlet on the same screen", async () => {
    serve(moving);
    signIn(asha("billing"));
    ui = await mount(App, "/outlet-requests");
    expect(ui.switcher()!.getAttribute("aria-label")).toBe("Working Billing at Coffee Shop. Change.");
    await press(ui.switcher());
    expect(ui.items().map((b) => [b.querySelector("b")?.textContent, b.getAttribute("aria-checked"), b.disabled])).toEqual([
      ["Coffee Shop", "true", true], ["Snack Kiosk", "false", false], ["Central Store", "false", false],
    ]);
    await press(ui.items()[1]);
    expect(sent("POST /auth/side")).toEqual({ side: "billing", loc: "kiosk" });
    expect(ui.where()).toBe("/outlet-requests");
    expect(ui.switcher()!.textContent).toContain("Snack Kiosk");
  });

  it("goes to the other side's home when that side has no such screen", async () => {
    // The snapshot is a round trip away, as it always is: the splash stands between the two sides,
    // so the till is never drawn against a side that has none (and never refused in a toast).
    let land!: () => void;
    const trip = new Promise<void>((r) => { land = r; });
    serve({ ...moving, "GET /snapshot": () => trip.then(() => snapshotOf(now)) });
    signIn(asha("billing"));
    ui = await mount(App, "/pos");
    await press(ui.switcher());
    await press(ui.items()[2]);
    expect(ui.text()).toContain("Loading…");
    expect(ui.where()).toBe("/issue");
    await act(async () => { land(); await new Promise((r) => { setTimeout(r, 0); }); });
    expect(ui.switcher()!.getAttribute("aria-label")).toBe("Working Inventory at Central Store. Change.");
    expect(S().toast).toBeNull();
  });

  it("asks before clearing a stock request being written, and keeps open bills", async () => {
    serve(moving);
    signIn(asha("billing"));
    useApp.setState({ draft: [{ it: "butter", qty: 2 }] as never, tills: { coffee: { bills: [], active: 0 } } as never });
    const tills = S().tills;
    ui = await mount(App, "/settings");
    await press(ui.switcher());
    await press(ui.items()[1]);
    expect(ui.text()).toContain("Leave this stock request?");
    expect(hits("POST /auth/side")).toHaveLength(0);
    await press(ui.button("Stay here"));
    expect(S().draft).toHaveLength(1);
    await press(ui.switcher());
    await press(ui.items()[1]);
    await press(ui.button("Clear it and move"));
    expect(S().user?.loc).toBe("kiosk");
    expect(S().draft).toEqual([]);
    expect(S().tills).toEqual(tills);
  });

  it("stays put, with the sentence, when the move is refused or the server cannot be reached", async () => {
    serve({ ...moving, "POST /auth/side": () => json({ error: { code: "rule", message: "You are not posted to Snack Kiosk." } }, 422) });
    signIn(asha("billing"));
    expect(await S().switchSide({ side: "billing", loc: "kiosk" })).toBe(false);
    expect(S().toast).toBe("You are not posted to Snack Kiosk.");
    expect(S().user?.loc).toBe("coffee");
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await S().switchSide({ side: "inventory" })).toBe(false);
    expect(S().toast).toContain("Could not reach the server");
  });

  it("names the outlet, not every outlet, as a two-sided role's place", () => {
    expect(homeLabel(asha("billing", "kiosk"))).toBe(LOC.kiosk.n);
  });
});

describe("a session moved from somewhere else", () => {
  it("reads a place off a token, and calls an unreadable one no move at all", () => {
    expect(placeIn(tok("counter", "kiosk"))).toBe("counter@kiosk");
    expect(placeIn(tok("counter", "kiosk", true))).toBe("counter@kiosk?");
    expect(placeIn("nonsense")).toBeNull();
    expect(placeIn(null)).toBeNull();
    expect(movedBetween(tok("counter", "kiosk"), tok("store", "store"))).toBe(true);
    expect(movedBetween(tok("counter", "kiosk"), tok("counter", "kiosk"))).toBe(false);
    expect(movedBetween("test-token", tok("store", "store"))).toBe(false);
  });

  it("does not send a write again from a different place, and takes the new place's data", async () => {
    signIn(asha("billing"));
    now = asha("inventory");
    serve({ ...moving, "POST /requests": () => json({ error: { code: "unauthenticated", message: "Your session has expired - sign in again." } }, 401), "POST /auth/refresh": () => answer(now) });
    const write = call(routes.createRequest, { body: { lines: [{ it: "butter", qty: 1 }], note: "", urgent: false } });
    await expect(write).rejects.toMatchObject({ status: 409 });
    await expect(write).rejects.toBeInstanceOf(ApiError);
    expect(hits("POST /requests")).toHaveLength(1);
    await vi.waitFor(() => { expect(S().auth).toBe("ready"); expect(S().user?.loc).toBe("store"); });
  });

  it("still retries a write from the same place, and any read", async () => {
    signIn(asha("billing"));
    let first = true;
    serve({ ...moving, "GET /me": () => { if (first) { first = false; return json({ error: { code: "unauthenticated", message: "x" } }, 401); } return json({ user: now, mustChangePassword: false }); }, "POST /auth/refresh": () => answer(now) });
    await call(routes.me);
    expect(hits("GET /me")).toHaveLength(2);
    expect(hits("GET /snapshot")).toHaveLength(0);
  });

  it("refreshes an aged-out token on the choice itself, unlike the other auth routes", async () => {
    signIn(asha("billing"));
    let first = true;
    serve({ ...moving, "POST /auth/refresh": () => answer(asha("billing")), "POST /auth/side": (init) => { if (first) { first = false; return json({ error: { code: "unauthenticated", message: "x" } }, 401); } return moving["POST /auth/side"](init); } });
    expect(await S().switchSide({ side: "inventory" })).toBe(true);
    expect(hits("POST /auth/side")).toHaveLength(2);
    expect(S().user?.loc).toBe("store");
  });

  it("asks for a side again when the refreshed session has none, and fails out loud when it cannot say", async () => {
    signIn(asha("billing"));
    serve({ "GET /me": () => json({ user: asha(null), mustChangePassword: false }) });
    await S().rejoin();
    expect(S().user?.sides?.at).toBeNull();
    expect(S().auth).toBe("ready");
    serve({});
    await S().rejoin();
    expect(S().auth).toBe("failed");
    useApp.setState({ user: null, auth: "signed-out" });
    await S().rejoin();
    expect(S().auth).toBe("signed-out");
  });

  it("follows another tab's switch", async () => {
    class Channel { static all: Channel[] = []; onmessage: ((e: { data: unknown }) => void) | null = null; constructor() { Channel.all.push(this); } postMessage() { /* not its own */ } close() { /* closed */ } }
    vi.stubGlobal("BroadcastChannel", Channel);
    signIn(asha("billing"));
    serve(moving);
    await call(routes.me);
    now = asha("inventory");
    Channel.all.at(-1)!.onmessage!({ data: { accessToken: tok("store", "store") } });
    await vi.waitFor(() => { expect(S().user?.loc).toBe("store"); expect(S().auth).toBe("ready"); });
  });

  it("opens no change stream until a side is chosen, and drops it if the choice is lost", async () => {
    serve({ "GET /events": () => new Response(new ReadableStream()), ...moving });
    signIn(asha(null));
    const off = startEventStream();
    try {
      expect(hits("GET /events")).toHaveLength(0);
      await S().switchSide({ side: "inventory" });
      expect(hits("GET /events")).toHaveLength(1);
      serve({ "GET /me": () => json({ user: asha(null), mustChangePassword: false }) });
      await S().rejoin();
      const signal = (hits("GET /events")[0][1] as RequestInit).signal!;
      expect(signal.aborted).toBe(true);
    } finally { off(); }
  });
});

describe("the super admin's pages", () => {
  const ROLE: AdminRole = { id: "ROLE-006", name: "Admin", desk: "counter", active: true, perms: ADMIN_PRESET.perms, inventory: ADMIN_PRESET.inventory, holders: 1, everAssigned: false, updatedAt: "2026-11-24T03:00:00.000Z" };
  const PLAIN: AdminRole = { ...ROLE, id: "ROLE-001", name: "Counter Operator", perms: DESK_DEFAULTS.counter.perms, inventory: undefined };
  const stubs = (roles: AdminRole[]): Stubs => ({ "GET /admin/roles": () => json(roles), "GET /admin/actions": () => json([]) });
  const Page = () => createElement(Fragment, null, createElement(AdminRoles), createElement(Drawer));
  const saved = (r: AdminRole) => json({ result: r, changed: [], message: "Saved." });
  const choose = async (el: HTMLSelectElement, v: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  beforeEach(() => { useApp.setState({ user: { ...FX.USERS.find((u) => u.admin)! }, auth: "ready", adminRoles: [], drawer: null }); setAccessToken("test-token"); });

  it("creates an Admin from the preset, on the counter desk, both sides at once", async () => {
    serve({ ...stubs([PLAIN]), "POST /admin/roles": () => saved(ROLE) });
    ui = await mount(Page);
    const [from, desk] = [...ui.host.querySelectorAll("select")];
    await choose(from, "admin");
    expect(desk.disabled).toBe(true);
    await press(ui.button("Create role"));
    expect(sent("POST /admin/roles")).toEqual({ name: "Admin", desk: "counter", perms: ADMIN_PRESET.perms, inventory: ADMIN_PRESET.inventory });
  });

  it("says a role has two sides, and edits each side's matrix on its own", async () => {
    serve({ ...stubs([ROLE, PLAIN]), "PATCH /admin/roles/ROLE-006": () => saved(ROLE) });
    ui = await mount(Page);
    expect(ui.text()).toContain("Counter + Inventory");
    await act(async () => { S().openDrawer("role", "ROLE-006"); });
    const level = (label: string, word: string) => [...ui!.host.querySelector(`[aria-label="${label} access"]`)!.querySelectorAll("button")].find((b) => b.textContent === word)!;
    expect(level("Inventory - Bills", "Edit").disabled).toBe(true);
    expect(level("Issue desk", "Edit").disabled).toBe(true);
    await press(level("Inventory - Vendors", "View"));
    expect(ui.text()).toContain("Inventory - Vendors: Edit → View");
    await press(ui.button("Save"));
    const body = sent("PATCH /admin/roles/ROLE-006") as { perms?: unknown; inventory: { f: Record<string, string> } };
    expect(body.perms).toBeUndefined();
    expect(body.inventory.f.vendors).toBe("view");
  });

  it("gives and takes the side away, and drops it with a move off the counter desk", async () => {
    serve({ ...stubs([ROLE, PLAIN]), "PATCH /admin/roles/ROLE-006": () => saved(ROLE), "PATCH /admin/roles/ROLE-001": () => saved(PLAIN) });
    ui = await mount(Page);
    await act(async () => { S().openDrawer("role", "ROLE-006"); });
    await press(ui.button("Has an Inventory side"));
    expect(ui.text()).toContain("Inventory side: taken away");
    expect(ui.host.querySelector('[aria-label="Inventory - Vendors access"]')).toBeNull();
    await press(ui.button("Save"));
    expect(sent("PATCH /admin/roles/ROLE-006")).toEqual({ inventory: null });
    await press(ui.button("Undo changes"));
    const desk = [...ui.host.querySelectorAll<HTMLSelectElement>(".drb select")][0];
    await choose(desk, "manager");
    expect(ui.text()).toContain("Inventory side: taken away");
    expect(ui.button("Has an Inventory side")).toBeUndefined();
    await act(async () => { S().openDrawer("role", "ROLE-001"); });
    await press(ui.button("Has an Inventory side"));
    expect(ui.text()).toContain("Inventory side: given");
  });

  it("offers no counters to tick for a two-sided account", async () => {
    const acct = (over: Partial<AdminUser>): AdminUser => ({ id: "u20", emp: "RC-4483", n: "Asha Admin", e: "a@b.in", ph: "", r: "counter", rl: "Admin", loc: "coffee", col: "#000", active: true, mustChangePassword: false, admin: false, postings: ["coffee"], rid: "ROLE-006", ...over });
    const LOCS = Object.entries(FX.LOC).filter(([k]) => k !== "quarantine").map(([key, l]) => ({ key, n: l.n, c: l.c, type: l.type, floor: l.floor, cc: l.cc, active: true, staff: 0 }));
    serve({ ...stubs([ROLE, PLAIN]), "GET /admin/users": () => json([acct({}), acct({ id: "u21", emp: "RC-4484", n: "Plain Counter", rid: "ROLE-001" })]), "GET /admin/locations": () => json(LOCS) });
    ui = await mount(AdminUsers);
    const row = (needle: string) => [...ui!.host.querySelectorAll("tbody tr")].find((tr) => tr.textContent?.includes(needle))!;
    expect(row("RC-4483").querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    expect(row("RC-4484").querySelectorAll("input[type=checkbox]").length).toBeGreaterThan(1);
  });
});
