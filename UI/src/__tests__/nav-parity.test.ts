import { beforeEach, describe, expect, it } from "vitest";
import { USERS } from "@rch/contract/fixtures";
import { canSee, homeFor, navFor } from "../nav";
import { LEGACY_KEYS, SCREENS } from "../screens";
import { userCan, userHolds, userWide } from "../lib/selectors";
import { LOC, homeLabel } from "../data/master";
import type { Role } from "../types";
import { resetStore, userOf } from "./fixture";

beforeEach(resetStore);

/**
 * Every desk's sidebar exactly as it stood before roles were configurable - `NAV` from
 * `UI/src/nav.ts` at a158b8b, copied here verbatim (the manager's hidden `avail` entry already
 * dropped, as `AVAILABILITY_SCREEN_ENABLED = false` dropped it). A seeded role must draw the same
 * groups, labels, icons and order; only the keys changed, and `LEGACY_KEYS` says to what.
 */
const LEGACY_NAV: Record<Role, { group: string; items: { k: string; label: string; icon: string }[] }[]> = {
  counter: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Sell", items: [
      { k: "pos", label: "Point of Sale", icon: "pos" },
      { k: "bills", label: "Bills", icon: "bill" },
      { k: "register", label: "Register", icon: "rep" }] },
    { group: "My counter", items: [{ k: "stock", label: "Stock in Hand", icon: "stock" }] },
    { group: "Movement", items: [{ k: "requests", label: "Stock Requests", icon: "req" }, { k: "tickets", label: "Pick Tickets", icon: "tkt" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  manager: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Movement", items: [{ k: "approvals", label: "Approvals", icon: "appr" }] },
    { group: "Outlets", items: [
      { k: "stock", label: "Items & Stock", icon: "item" },
      { k: "menu", label: "Menu Management", icon: "order" },
      { k: "prices", label: "Prices", icon: "price" },
      { k: "bills", label: "Bills", icon: "bill" },
      { k: "register", label: "Register", icon: "rep" }] },
    { group: "Credit", items: [{ k: "credit", label: "Credit & Settlements", icon: "rep" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  store: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Issue", items: [{ k: "issue", label: "Issue Desk", icon: "tkt" }] },
    { group: "Inventory", items: [
      { k: "stock", label: "Stock in Hand", icon: "stock" },
      { k: "adjust", label: "Adjustments", icon: "item" }] },
    { group: "Purchasing", items: [
      { k: "procure", label: "Requisitions", icon: "need" }] },
    { group: "Insights", items: [{ k: "reports", label: "Reports", icon: "rep" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  prod: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Kitchen", items: [
      { k: "orders", label: "Orders", icon: "order" },
      { k: "make", label: "Make & Distribute", icon: "make" }] },
    { group: "Stock", items: [{ k: "stock", label: "Kitchen Stock", icon: "stock" }, { k: "avail", label: "Product On / Off", icon: "power" }] },
    { group: "Movement", items: [{ k: "requests", label: "Stock Requests", icon: "req" }, { k: "tickets", label: "Pick Tickets", icon: "tkt" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
  buyer: [
    { group: "Overview", items: [{ k: "dash", label: "Dashboard", icon: "dash" }] },
    { group: "Purchasing", items: [
      { k: "requisitions", label: "Requisitions", icon: "need" },
      { k: "pool", label: "Procurement List", icon: "req" },
      { k: "orders", label: "Purchase Orders", icon: "order" },
      { k: "contracts", label: "Rate Contracts", icon: "price" }] },
    { group: "Inventory", items: [
      { k: "inventory", label: "Inventory", icon: "item" },
      { k: "newproducts", label: "New Products", icon: "need" }] },
    { group: "Masters", items: [{ k: "vendors", label: "Vendors", icon: "item" }] },
    { group: "Account", items: [{ k: "issues", label: "Support", icon: "req" }, { k: "settings", label: "Settings", icon: "set" }] },
  ],
};
/** `HOME` from the same commit. */
const LEGACY_HOME: Record<Role, string> = {
  counter: "pos", manager: "approvals", store: "issue", prod: "orders", buyer: "requisitions",
};

const DESKS = Object.keys(LEGACY_NAV) as Role[];
const renamed = (r: Role, k: string) => LEGACY_KEYS[r][k] ?? k;

describe("a seeded role's sidebar is its desk's old sidebar, keys renamed", () => {
  for (const r of DESKS) {
    it(r, () => {
      const want = LEGACY_NAV[r].map((g) => ({ group: g.group, items: g.items.map((i) => ({ ...i, k: renamed(r, i.k) })) }));
      expect(navFor(userOf(r))).toEqual(want);
    });
    it(`${r} lands where it always did`, () => {
      expect(homeFor(userOf(r))).toBe(renamed(r, LEGACY_HOME[r]));
    });
  }
  it("every account on the fixtures, not only the first of each desk", () => {
    for (const u of USERS.filter((x) => !x.admin))
      expect(navFor(u).flatMap((g) => g.items.map((i) => i.k)))
        .toEqual(LEGACY_NAV[u.r].flatMap((g) => g.items.map((i) => renamed(u.r, i.k))));
  });
});

describe("a screen from another desk's layout", () => {
  it("names its section when its label is already in the sidebar", () => {
    const store = userOf("store");
    const nav = navFor({ ...store, perms: { f: { ...store.perms!.f, requisitions: "edit" }, a: [] } });
    const purchasing = nav.find((g) => g.group === "Purchasing")!.items;
    expect(purchasing).toEqual([
      { k: "procure", label: "Requisitions", icon: "need" },
      { k: "requisitions", label: "Requisitions (purchasing)", icon: "need" },
    ]);
    const labels = nav.flatMap((g) => g.items.map((i) => i.label));
    expect(new Set(labels).size).toBe(labels.length);
  });
  it("keeps its own label when nothing else carries it", () => {
    const store = userOf("store");
    const nav = navFor({ ...store, perms: { f: { ...store.perms!.f, vendors: "view" }, a: [] } });
    expect(nav.flatMap((g) => g.items).find((i) => i.k === "vendors")!.label).toBe("Vendors");
  });
});

describe("screen keys", () => {
  it("are unique", () => {
    const keys = SCREENS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("every old key a desk used redirects to a screen that desk can see", () => {
    for (const r of DESKS)
      for (const to of Object.values(LEGACY_KEYS[r])) expect(canSee(userOf(r), to!)).toBe(true);
  });
  it("a key nobody has is never visible", () => {
    expect(canSee(userOf("manager"), "stock")).toBe(false);
    expect(canSee(userOf("manager"), "nonsense")).toBe(false);
  });
});

describe("who reads hospital-wide", () => {
  it("every desk but the counter, as seeded", () => {
    for (const r of DESKS) expect(userWide(userOf(r))).toBe(r !== "counter");
  });
  it("a counter role given every outlet, or any hospital-wide feature", () => {
    const counter = userOf("counter");
    expect(userWide({ ...counter, perms: { ...counter.perms!, a: ["all_outlets"] } })).toBe(true);
    expect(userWide({ ...counter, perms: { f: { ...counter.perms!.f, credit: "view" }, a: [] } })).toBe(true);
    expect(homeLabel({ ...counter, perms: { ...counter.perms!, a: ["all_outlets"] } })).toBe("All outlets");
    expect(homeLabel(counter)).toBe(LOC[counter.loc].n);
  });
  it("a user record with no permissions holds its desk's seeded role", () => {
    const { perms: _none, ...bare } = userOf("manager");
    expect(userCan(bare, "approvals", "edit")).toBe(true);
    expect(userHolds(bare, "void_bill")).toBe(true);
    expect(userCan(bare, "billing", "edit")).toBe(false);
  });
});
