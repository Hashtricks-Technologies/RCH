import { describe, expect, it } from "vitest";
import { act, createElement, type ComponentType, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { useApp } from "../store";
import { USERS } from "../data/master";
import { NAV } from "../nav";
import { DRAWERS } from "../drawers";
import Settings from "../pages/Settings";
import Login from "../pages/Login";
import { screens as counter } from "../roles/counter";
import { screens as manager } from "../roles/manager";
import { screens as store } from "../roles/store";
import { screens as prod } from "../roles/prod";
import { screens as buyer } from "../roles/buyer";
import type { Role } from "../types";

const REGISTRY: Record<Role, Record<string, ComponentType>> = { counter, manager, store, prod, buyer };

/** Render on the client, the way the app actually runs. */
function render(el: ReactElement): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, el)); });
  const html = host.innerHTML;
  act(() => { root.unmount(); });
  host.remove();
  return html;
}

describe("every screen renders for its role", () => {
  for (const u of USERS) {
    for (const k of NAV[u.r].flatMap((g) => g.items.map((i) => i.k))) {
      it(`${u.r}/${k}`, () => {
        act(() => { useApp.getState().signIn(u.id); });
        const C = k === "settings" ? Settings : REGISTRY[u.r][k];
        expect(C, `no component registered for ${u.r}/${k}`).toBeTruthy();
        expect(render(createElement(C)).length).toBeGreaterThan(400);
      });
    }
  }
});

describe("the sidebar matches the screen registry", () => {
  for (const u of USERS) {
    it(`${u.r}`, () => {
      const navKeys = NAV[u.r].flatMap((g) => g.items.map((i) => i.k)).filter((k) => k !== "settings");
      expect(navKeys.sort()).toEqual(Object.keys(REGISTRY[u.r]).sort());
    });
  }
});

describe("a role cannot reach another role's screens", () => {
  it("counter has no approvals, prices, issue or requisitions", () => {
    const keys = NAV.counter.flatMap((g) => g.items.map((i) => i.k));
    for (const forbidden of ["approvals", "prices", "issue", "procure", "requisitions", "orders", "make"])
      expect(keys).not.toContain(forbidden);
  });
  it("only the counter sells", () => {
    for (const r of ["manager", "store", "prod", "buyer"] as Role[])
      expect(NAV[r].flatMap((g) => g.items.map((i) => i.k))).not.toContain("pos");
  });
  it("every role has settings", () => {
    for (const r of Object.keys(NAV) as Role[])
      expect(NAV[r].flatMap((g) => g.items.map((i) => i.k))).toContain("settings");
  });
});

describe("drawers render", () => {
  const cases: [string, string, Role][] = [
    ["cbill", "CF/1187", "counter"], ["creq", "REQ-2026-0911", "counter"], ["ctkt", "TKT-0440", "counter"],
    ["mreq", "REQ-2026-0911", "manager"], ["stkt", "TKT-0440", "store"],
    ["pord", "PRD-2026-029", "prod"], ["bprq", "PRQ-2026-013", "buyer"],
    ["bpo", "PO-2026-0140", "buyer"],
    ["bgrn", "PO-2026-0141", "buyer"],
  ];
  for (const [key, id, role] of cases) {
    it(key, () => {
      act(() => { useApp.getState().signIn(USERS.find((u) => u.r === role)!.id); });
      const C = DRAWERS[key];
      expect(C, `drawer "${key}" is not registered`).toBeTruthy();
      expect(render(createElement(C, { id })).length).toBeGreaterThan(200);
    });
  }
});

describe("sign-in", () => {
  it("lists all five accounts", () => {
    act(() => { useApp.setState({ user: null }); });
    const html = render(createElement(Login));
    for (const u of USERS) expect(html).toContain(u.n);
  });
});
