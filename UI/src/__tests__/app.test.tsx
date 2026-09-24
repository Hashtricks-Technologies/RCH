import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { useApp } from "../store";
import { USERS } from "@rch/contract/fixtures";
import { homeFor, navFor } from "../nav";
import { IT } from "../data/master";
import { DESK_DEFAULTS } from "@rch/domain";
import { as, resetStore, signedOut } from "./fixture";

// The store starts empty now and the registries with it, so the roles this suite iterates come
// from the fixtures - a test file is where they belong - and every case seeds the demo hospital
// before it renders anything.
beforeEach(resetStore);

/**
 * Renders the WHOLE app - router, Shell and screen together.
 * The bare-screen tests miss anything that only breaks inside the shell.
 */
function mountApp(route: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(MemoryRouter, { initialEntries: [route] }, createElement(App)));
  });
  const html = host.innerHTML;
  act(() => { root.unmount(); });
  host.remove();
  return html;
}

describe("the whole app mounts for every role on every route", () => {
  // Not the admin-flagged fixture account: it has no operational nav at all (a capability, not
  // a role - root CLAUDE.md), so this loop would otherwise generate a duplicate `buyer/...`
  // case for it under a role it never actually renders. Its own routing is covered below.
  for (const u of USERS.filter((u) => !u.admin)) {
    for (const k of navFor(u).flatMap((g) => g.items.map((i) => i.k))) {
      it(`${u.r} at /${k}`, () => {
        act(() => { as(u.r); });
        const html = mountApp("/" + k);
        // the shell itself must be present, not just the screen
        expect(html, "sidebar missing - the shell did not render").toContain("Royal Care");
        // every role can put the sidebar away, and get it back
        expect(html, "no way to hide the sidebar").toContain('aria-label="Hide the sidebar"');
        expect(html, "no way to bring the sidebar back").toContain('aria-label="Show the sidebar"');
        expect(html.length).toBeGreaterThan(1500);
      });
    }
  }
});

describe("routing", () => {
  it("signed out, any route falls back to the sign-in screen", () => {
    act(() => { signedOut(); });
    expect(mountApp("/pos")).toContain("Sign in");
  });
  it("a role sent to another role's route is redirected home", () => {
    act(() => { as("counter"); });
    const html = mountApp("/approvals");             // outlet manager territory
    expect(html).not.toContain("Approval queue");
    expect(html).toContain("Royal Care");
  });
  it("an old key lands on the screen it always meant, under its new name", () => {
    act(() => { as("prod"); });
    const kitchen = mountApp("/orders");
    expect(kitchen).not.toContain("is not available");
    expect(kitchen).toContain('href="/kitchen-orders" data-discover="true" aria-current="page"');
    act(() => { as("buyer"); });
    expect(mountApp("/orders")).toContain('href="/purchase-orders" data-discover="true" aria-current="page"');
  });
  it("an old key another desk used is refused by name, not redirected", () => {
    act(() => { as("counter"); });
    expect(mountApp("/orders")).toContain("orders is not available to a Counter Operator");
  });
  // ---- configurable roles: the screens follow what the role holds, not which desk it is on.
  it("a counter role given Credit sees it on its sidebar, and can open it", () => {
    act(() => {
      as("counter");
      const u = useApp.getState().user!;
      useApp.setState({ user: { ...u, perms: { f: { ...DESK_DEFAULTS.counter.perms.f, credit: "edit" }, a: [] } } });
    });
    const html = mountApp("/credit");
    expect(html).not.toContain("is not available");
    expect(html).toContain("Credit &amp; settlements");
    // Its own group, after the counter's own and before Account.
    const groups = [...html.matchAll(/class="navg">([^<]+)</g)].map((m) => m[1]);
    expect(groups).toEqual(["Overview", "Sell", "My counter", "Movement", "Credit", "Account"]);
  });
  it("a screen the role no longer grants is refused by name and the session sent home", () => {
    act(() => {
      as("counter");
      const u = useApp.getState().user!;
      const { outlet_stock: _gone, ...f } = DESK_DEFAULTS.counter.perms.f;
      useApp.setState({ user: { ...u, perms: { f, a: [] } } });
    });
    const html = mountApp("/outlet-stock");
    expect(html).toContain("Stock in Hand is not available to a Counter Operator");
    expect(html).not.toContain('href="/outlet-stock"');
  });
  it("a counter role given every outlet reads every outlet's bills", () => {
    act(() => {
      as("counter");
      const u = useApp.getState().user!;
      useApp.setState({ user: { ...u, perms: { ...DESK_DEFAULTS.counter.perms, a: ["all_outlets"] } } });
    });
    expect(mountApp("/bills")).toContain("Bills from every outlet in the last seven days.");
    act(() => { as("counter"); });
    expect(mountApp("/bills")).not.toContain("Bills from every outlet in the last seven days.");
  });
  it("each role lands on its own home screen", () => {
    for (const u of USERS.filter((u) => !u.admin)) {
      act(() => { as(u.r); });
      expect(mountApp("/" + homeFor(u)).length).toBeGreaterThan(1500);
    }
  });

  it("/admin is on no role's sidebar, and refuses an ordinary account by name (UA-01)", () => {
    act(() => { as("manager"); });
    const html = mountApp("/admin");
    // Redirected home (Approvals), not the account-management page itself.
    expect(html).not.toContain("Create an account");
    expect(html).toContain("Stock request approvals");
    // UA-01: told why, by name, not bounced in silence.
    expect(html).toContain("Manage staff accounts is not available to an Outlet Manager");
  });

  it("an admin-flagged account sees no operational shell at all - a capability, not a role", () => {
    act(() => { as("manager"); useApp.setState({ user: { ...useApp.getState().user!, admin: true } }); });
    const html = mountApp("/admin");
    expect(html).toContain("Create an account");
    // No sidebar, no "Hide the sidebar" toggle - this account has no operational nav to hide.
    expect(html).not.toContain('aria-label="Hide the sidebar"');
    expect(html).not.toContain("Approvals");
  });
  it("an admin-flagged account is bounced off any other key, back to the one place it has", () => {
    act(() => { as("manager"); useApp.setState({ user: { ...useApp.getState().user!, admin: true } }); });
    const html = mountApp("/pos");
    expect(html).toContain("Create an account");
    expect(html).not.toContain("Point of Sale");
  });
});

/** The number beside a sidebar entry, or 0 when the shell draws none. */
function badge(route: string, key: string): number {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(MemoryRouter, { initialEntries: [route] }, createElement(App)));
  });
  const n = Number(host.querySelector(`a[href="/${key}"] .ct`)?.textContent ?? 0);
  act(() => { root.unmount(); });
  host.remove();
  return n;
}

describe("the header status dot and the offline banner", () => {
  /** The dot's own colour, read off the element the header draws. */
  const dot = (route: string) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(MemoryRouter, { initialEntries: [route] }, createElement(App))); });
    const el = host.querySelector(".org .dt") as HTMLElement | null;
    const read = { colour: el?.style.background ?? "", label: el?.getAttribute("aria-label") ?? "" };
    act(() => { root.unmount(); });
    host.remove();
    return read;
  };

  it("does not paint the dot green when the live stream is not running", () => {
    // The Support FAQ points the operator at this dot. It was a <button> with no onClick and
    // `background: var(--good)` in the stylesheet, so it read "all well" with the stream down.
    act(() => { as("counter"); });
    const { colour, label } = dot("/pos");
    expect(colour).toBe("var(--ink-4)");          // "off" - no stream is running in a test
    expect(label).toContain("live updates");
  });

  it("says so on every screen while the terminal is offline", () => {
    act(() => { as("counter"); });
    const online = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    try {
      expect(mountApp("/pos")).toContain("No network - this terminal is offline");
    } finally {
      Reflect.deleteProperty(navigator, "onLine");
      if (online) Object.defineProperty(Navigator.prototype, "onLine", online);
    }
  });

  it("says nothing when the terminal is on the network", () => {
    act(() => { as("counter"); });
    expect(mountApp("/pos")).not.toContain("No network - this terminal is offline");
  });
});

describe("the sidebar badge counts what is still coming", () => {
  it("stops counting a ticket once it has been withdrawn (I2)", () => {
    // TKT-0440 is the Coffee Shop's only ticket: 500 cups, still at the store's window.
    act(() => { as("counter"); });
    expect(badge("/pos", "outlet-tickets")).toBe(1);

    // Received and withdrawn are both nothing to go and collect - the badge counted the
    // second for the rest of the day, because it only knew how to stop counting the first.
    act(() => { useApp.setState({ tkt: useApp.getState().tkt.map((t) => ({ ...t, st: "Received" as const })) }); });
    expect(badge("/pos", "outlet-tickets")).toBe(0);
    act(() => { useApp.setState({ tkt: useApp.getState().tkt.map((t) => ({ ...t, st: "Cancelled" as const })) }); });
    expect(badge("/pos", "outlet-tickets")).toBe(0);
  });

  /** Every item that is ever reordered, carried well above its own reorder level - a clean
   *  zero baseline neither role's badge has to share with whatever the fixture happens to hold. */
  function clearReorder() {
    const store: Record<string, number> = {};
    for (const k of Object.keys(IT)) if (IT[k].rl > 0) store[k] = IT[k].rl * 10;
    useApp.setState((s) => ({ stock: { ...s.stock, store } }));
  }
  const setStoreQty = (it: string, q: number) =>
    useApp.setState((s) => ({ stock: { ...s.stock, store: { ...s.stock.store, [it]: q } } }));

  it("counts central-store items below their reorder level, for the buyer and the store keeper", () => {
    act(() => { as("buyer"); clearReorder(); });
    expect(badge("/requisitions", "inventory")).toBe(0);
    act(() => { setStoreQty("juice", 10); }); // rl 60
    expect(badge("/requisitions", "inventory")).toBe(1);
    act(() => { setStoreQty("juice", 100); });
    expect(badge("/requisitions", "inventory")).toBe(0);

    act(() => { as("store"); clearReorder(); });
    expect(badge("/issue", "store-stock")).toBe(0);
    act(() => { setStoreQty("juice", 10); });
    expect(badge("/issue", "store-stock")).toBe(1);
  });

  it("does not count a low-stock badge for any other role", () => {
    act(() => { as("counter"); clearReorder(); setStoreQty("juice", 10); });
    expect(badge("/pos", "inventory")).toBe(0);
    act(() => { as("manager"); clearReorder(); setStoreQty("juice", 10); });
    expect(badge("/approvals", "items-stock")).toBe(0);
  });
});

describe("the kitchen's approaching-best-before badge", () => {
  // Fixed rather than read off the host, the same reason fixes.test.ts's H9 block fixes its
  // own clock: this badge's whole job is to react to the clock, so the clock cannot also be
  // the thing quietly making the case pass or fail.
  const t0 = new Date("2026-08-29T10:00:00+05:30");
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(t0); });
  afterEach(() => { vi.useRealTimers(); });

  /** `puff`'s own shelf life is 12 hours (packages/contract/src/fixtures/master.ts) - a batch
   *  made `hoursAgo` before `t0` is due `12 - hoursAgo` hours from `t0`. */
  const puffBatch = (id: string, hoursAgo: number) => ({
    id, it: "puff", qty: 10, made: 10, at: "10:00", bb: "note",
    iso: new Date(t0.getTime() - hoursAgo * 3_600_000).toISOString(),
  });

  it("counts a batch due within 2 hours, not one due later or one already past", () => {
    act(() => { as("prod"); });
    act(() => {
      useApp.setState({
        batch: [
          puffBatch("B1", 0),     // due in 12h - not yet approaching
          puffBatch("B2", 10.5),  // due in 1h30m - approaching
          puffBatch("B3", 13),    // due 1h ago - already past
        ],
      });
    });
    expect(badge("/kitchen-orders", "dash")).toBe(1);
  });

  it("updates on its own as the clock moves toward a batch's best-before", () => {
    act(() => { as("prod"); });
    act(() => { useApp.setState({ batch: [puffBatch("B4", 9)] }); }); // due in 3h
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const read = () => Number(host.querySelector('a[href="/dash"] .ct')?.textContent ?? 0);
    act(() => { root.render(createElement(MemoryRouter, { initialEntries: ["/orders"] }, createElement(App))); });
    expect(read()).toBe(0);
    // An hour and a bit passes with nothing else happening: the batch is now due in under 2h.
    act(() => { vi.advanceTimersByTime(65 * 60_000); });
    expect(read()).toBe(1);
    act(() => { root.unmount(); });
    host.remove();
  });
});
