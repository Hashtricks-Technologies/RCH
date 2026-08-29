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
import { groupPool, picksFor, type PoolGroup } from "../roles/buyer/ProcurementList";
import { seedVendors } from "../data/vendors";
import type { PoolLine } from "../lib/selectors";
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
    ["bpo", "PO-2026-0141", "buyer"],
    ["bgrn", "PO-2026-0141", "buyer"],
    ["bven", "VN-001", "buyer"],
  ];
  for (const [key, id, role] of cases) {
    it(key, () => {
      act(() => { useApp.getState().signIn(USERS.find((u) => u.r === role)!.id); });
      const C = DRAWERS[key];
      expect(C, `drawer "${key}" is not registered`).toBeTruthy();
      expect(render(createElement(C, { id })).length).toBeGreaterThan(200);
    });
  }

  // Not a row in `cases` above: PO-2026-0142 (milk, butter — neither has a printed MRP)
  // shares the "bgrn" key with PO-2026-0141 (juice, water — both have one), and the shared
  // loop titles each case by `key` alone, so a second "bgrn" row there would collide on
  // test title. Rendered directly instead, pinning both arms of the "Not printed" branch.
  it("bgrn shows 'Not printed' only for lines with no printed MRP", () => {
    act(() => { useApp.getState().signIn(USERS.find((u) => u.r === "buyer")!.id); });
    const C = DRAWERS.bgrn;
    const withMrp = render(createElement(C, { id: "PO-2026-0141" }));
    const withoutMrp = render(createElement(C, { id: "PO-2026-0142" }));
    expect(withoutMrp).toContain("Not printed");
    expect(withMrp).not.toContain("Not printed");
  });

  // Not a row in `cases` above: id "new" opens the empty create-vendor form,
  // which shares the "bven" key with VN-001's edit form and would collide on
  // the shared loop's test title. Rendered directly instead, to pin the
  // create-mode branch — no vendor loaded, so no Deactivate/Reactivate
  // footer control — that VN-001's row never exercises.
  it("bven shows an empty create form for a new vendor, with no deactivate control", () => {
    act(() => { useApp.getState().signIn(USERS.find((u) => u.r === "buyer")!.id); });
    const html = render(createElement(DRAWERS.bven, { id: "new" }));
    expect(html).toContain("Add vendor");
    expect(html).not.toContain("Deactivate");
    expect(html).not.toContain("Reactivate");
  });
});

describe("sign-in", () => {
  it("lists all five accounts", () => {
    act(() => { useApp.setState({ user: null }); });
    const html = render(createElement(Login));
    for (const u of USERS) expect(html).toContain(u.n);
  });
});

describe("procurement list", () => {
  it("renders the pooled lines, grouped by item, with a source breakdown", () => {
    act(() => { useApp.getState().signIn(USERS.find((u) => u.r === "buyer")!.id); });
    const html = render(createElement(buyer.pool));
    expect(html).toContain("Procurement list");
    expect(html).toMatch(/Maida/);
    // The seeded pool: maida 20 from PRQ-2026-014, milk 25 from PRQ-2026-011 —
    // both must show up as their own source chip.
    expect(html).toContain("PRQ-2026-014");
    expect(html).toContain("PRQ-2026-011");
  });

  it("folds several requisitions for the same item into one pooled group", () => {
    // A flat list of raw pool lines would list milk twice; the screen's job
    // is to read it as one row with two sources, so this pins the merge
    // logic directly rather than through rendered HTML.
    const pool: PoolLine[] = [
      { prq: "PRQ-2026-011", line: 0, it: "milk", asked: 25, pending: 25, by: "Suresh Muthu", at: "06:30" },
      { prq: "PRQ-2026-013", line: 0, it: "milk", asked: 60, pending: 60, by: "Suresh Muthu", at: "07:50" },
      { prq: "PRQ-2026-014", line: 1, it: "maida", asked: 20, pending: 20, by: "Suresh Muthu", at: "07:40" },
    ];
    const groups = groupPool(pool, seedVendors);
    expect(groups).toHaveLength(2);

    const milk = groups.find((g) => g.it === "milk")!;
    expect(milk.pending).toBe(85);
    expect(milk.sources.map((s) => s.prq)).toEqual(["PRQ-2026-011", "PRQ-2026-013"]);
    expect(milk.vendor?.n).toBe("Aavin Dairy Depot");

    const maida = groups.find((g) => g.it === "maida")!;
    expect(maida.sources).toHaveLength(1);
    expect(maida.vendor?.n).toBe("Anandha Provisions");
  });

  it("splits a picked quantity across a group's sources, capped by what each still has pending", () => {
    const g: PoolGroup = {
      it: "milk",
      pending: 85,
      vendor: null,
      sources: [
        { prq: "PRQ-2026-011", line: 0, it: "milk", asked: 25, pending: 25, by: "Suresh Muthu", at: "06:30" },
        { prq: "PRQ-2026-013", line: 0, it: "milk", asked: 60, pending: 60, by: "Suresh Muthu", at: "07:50" },
      ],
    };
    // Taking less than the first source covers stays on that source alone —
    // this is the "take part now, the rest on a second pass" split.
    expect(picksFor(g, 10)).toEqual([{ prq: "PRQ-2026-011", line: 0, qty: 10 }]);
    // Spilling past the first source's pending draws the remainder from the next.
    expect(picksFor(g, 40)).toEqual([
      { prq: "PRQ-2026-011", line: 0, qty: 25 },
      { prq: "PRQ-2026-013", line: 0, qty: 15 },
    ]);
    // Never over-allocates past the group's total pending.
    expect(picksFor(g, 999)).toEqual([
      { prq: "PRQ-2026-011", line: 0, qty: 25 },
      { prq: "PRQ-2026-013", line: 0, qty: 60 },
    ]);
    expect(picksFor(g, 0)).toEqual([]);
  });
});
