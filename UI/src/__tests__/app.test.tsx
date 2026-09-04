import { beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import App from "../App";
import { useApp } from "../store";
import { USERS } from "@rch/contract/fixtures";
import { NAV, HOME } from "../nav";
import { as, resetStore, signedOut } from "./fixture";

// The store starts empty now and the registries with it, so the roles this suite iterates come
// from the fixtures — a test file is where they belong — and every case seeds the demo hospital
// before it renders anything.
beforeEach(resetStore);

/**
 * Renders the WHOLE app — router, Shell and screen together.
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
  for (const u of USERS) {
    for (const k of NAV[u.r].flatMap((g) => g.items.map((i) => i.k))) {
      it(`${u.r} at /${k}`, () => {
        act(() => { as(u.r); });
        const html = mountApp("/" + k);
        // the shell itself must be present, not just the screen
        expect(html, "sidebar missing — the shell did not render").toContain("Royal Care");
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
  it("each role lands on its own home screen", () => {
    for (const u of USERS) {
      act(() => { as(u.r); });
      expect(mountApp("/" + HOME[u.r]).length).toBeGreaterThan(1500);
    }
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

describe("the sidebar badge counts what is still coming", () => {
  it("stops counting a ticket once it has been withdrawn (I2)", () => {
    // TKT-0440 is the Coffee Shop's only ticket: 500 cups, still at the store's window.
    act(() => { as("counter"); });
    expect(badge("/pos", "tickets")).toBe(1);

    // Received and withdrawn are both nothing to go and collect — the badge counted the
    // second for the rest of the day, because it only knew how to stop counting the first.
    act(() => { useApp.setState({ tkt: useApp.getState().tkt.map((t) => ({ ...t, st: "Received" as const })) }); });
    expect(badge("/pos", "tickets")).toBe(0);
    act(() => { useApp.setState({ tkt: useApp.getState().tkt.map((t) => ({ ...t, st: "Cancelled" as const })) }); });
    expect(badge("/pos", "tickets")).toBe(0);
  });
});
