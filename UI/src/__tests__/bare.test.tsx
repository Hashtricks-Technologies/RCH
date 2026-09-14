import { beforeEach, describe, expect, it } from "vitest";
import { act, createElement, type ComponentType, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import * as FX from "@rch/contract/fixtures";
import { useApp } from "../store";
import { NAV } from "../nav";
import { DRAWERS } from "../drawers";
import { hydrateMaster, hydrateRoster } from "../data/master";
import Settings from "../pages/Settings";
import Issues from "../pages/Support";
import { screens as counter } from "../roles/counter";
import { screens as manager } from "../roles/manager";
import { screens as store } from "../roles/store";
import { screens as prod } from "../roles/prod";
import { screens as buyer } from "../roles/buyer";
import type { Role, StockLoc } from "../types";
import { as, resetStore } from "./fixture";

/**
 * A hospital with nothing in it - what `GET /snapshot` answers on a database seeded `--bare`,
 * which is how a real deployment starts (`deploy/compose/deploy.sh`). The six locations are there,
 * because `LocKey` is a closed union the whole app is written against; everything else is empty:
 * no item, price, menu, stock line, payer, vendor or document.
 *
 * `screens.test.tsx` renders every screen over the demo hospital, which always has an item, a
 * menu and a bill to point at. A screen that reads `menu[loc].includes(...)`, `PRODS[0]` or a
 * first bill without checking is fine there and a white page here - on the very first morning
 * a real deployment is used. This file is the other half of that loop.
 */

const REGISTRY: Record<Role, Record<string, ComponentType>> = { counter, manager, store, prod, buyer };
const EMPTY_STOCK: Record<StockLoc, Record<string, number>> = { store: {}, kitchen: {}, rest: {}, coffee: {}, kiosk: {}, quarantine: {} };
const DAYS = 14;

function bareHospital() {
  resetStore();
  // Exactly what the server's readers answer on an empty database: `readMenu` and `readPrices`
  // build their objects from rows, so with no rows there is no outlet key at all, and `readSales`
  // still answers a zero for every outlet on every day of its window.
  hydrateMaster({ items: {}, locations: FX.LOC, prices: { A: {}, B: {} }, menu: {}, users: FX.USERS });
  hydrateRoster({ patients: [], staff: [], depts: [] });
  useApp.setState({
    stock: EMPTY_STOCK, rsv: {}, ovr: {}, prices: { A: {}, B: {} }, menu: {},
    req: [], tkt: [], prq: [], po: [], pord: [], batch: [], bills: [], grn: [], vendors: [],
    contracts: [], productReqs: [], shopAsks: [], tickets: [], adjustments: [],
    sales: Array.from({ length: DAYS }, () => [0, 0, 0]),
    dayLabels: Array.from({ length: DAYS }, (_, i) => String(i + 1).padStart(2, "0")),
  });
}
beforeEach(bareHospital);

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

describe("every screen renders on a hospital with nothing in it", () => {
  for (const u of FX.USERS.filter((x) => !x.admin)) {
    for (const k of NAV[u.r].flatMap((g) => g.items.map((i) => i.k))) {
      it(`${u.r}/${k}`, () => {
        act(() => { as(u.r); });
        const C = k === "settings" ? Settings : k === "issues" ? Issues : REGISTRY[u.r][k];
        expect(render(createElement(C)).length).toBeGreaterThan(200);
      });
    }
  }
});

// The drawers a first morning actually opens: the three Add Product forms, the manager's
// kitchen order and a write-off - every other drawer opens over a document, and there are none.
describe("the forms that fill an empty hospital render", () => {
  const OPEN: [key: string, id: string, role: Role][] = [
    ["sitem", "new", "store"], ["bnewitem", "new", "buyer"], ["pnew", "new", "prod"],
    ["korder", "new", "manager"], ["adjstock", "coffee", "manager"],
  ];
  for (const [key, id, role] of OPEN) {
    it(key, () => {
      act(() => { as(role); });
      expect(DRAWERS[key], `no drawer registered as "${key}"`).toBeTruthy();
      expect(render(createElement(DRAWERS[key], { id })).length).toBeGreaterThan(200);
    });
  }
});
