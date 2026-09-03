import { describe, expect, it } from "vitest";
import { IT, LOC, MENU, PL, RCP, USERS, seedBills, seedPo, seedPrq, seedReq, seedStock, seedTkt } from "./index";

describe("fixtures", () => {
  it("every menu, recipe, price and stock line names a real item", () => {
    const items = new Set(Object.keys(IT));
    for (const keys of Object.values(MENU)) for (const k of keys) expect(items.has(k), k).toBe(true);
    for (const r of Object.values(RCP)) for (const [g] of r.l) expect(items.has(g), g).toBe(true);
    for (const list of Object.values(PL)) for (const k of Object.keys(list)) expect(items.has(k), k).toBe(true);
    for (const loc of Object.values(seedStock)) for (const k of Object.keys(loc)) expect(items.has(k), k).toBe(true);
  });
  it("every document line names a real item and every location is known", () => {
    const items = new Set(Object.keys(IT));
    const locs = new Set(Object.keys(LOC));
    for (const r of seedReq) { expect(locs.has(r.from)).toBe(true); for (const l of r.lines) expect(items.has(l.it)).toBe(true); }
    for (const t of seedTkt) { expect(locs.has(t.from) && locs.has(t.to)).toBe(true); for (const l of t.lines) expect(items.has(l.it)).toBe(true); }
    for (const p of seedPrq) for (const l of p.lines) expect(items.has(l.it)).toBe(true);
    for (const o of seedPo) for (const l of o.lines) expect(items.has(l.it)).toBe(true);
    for (const b of seedBills) { expect(locs.has(b.loc)).toBe(true); for (const l of b.lines) expect(items.has(l.it)).toBe(true); }
  });
  it("users are unique by id, employee number and display name", () => {
    expect(new Set(USERS.map((u) => u.id)).size).toBe(USERS.length);
    expect(new Set(USERS.map((u) => u.emp)).size).toBe(USERS.length);
    // Support tickets are scoped to their raiser by display name (snapshot/scope.ts), so two
    // people sharing a name would see each other's tickets.
    expect(new Set(USERS.map((u) => u.n)).size).toBe(USERS.length);
  });
});
