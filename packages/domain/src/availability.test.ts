import { describe, expect, it } from "vitest";
import { IT, LOC, RCP, seedStock } from "@rch/contract/fixtures";
import { availOf } from "./availability";
const M = { items: IT, locations: LOC, recipes: RCP };
describe("availOf", () => {
  it("a manual override wins", () => { expect(availOf(M, seedStock, {}, { "coffee:capp": "switched off manually" }, "coffee", "capp")).toEqual({ ok: false, mode: "Manual", why: "switched off manually" }); });
  it("a made-to-order item is off when an ingredient runs out and names it", () => {
    const a = availOf(M, seedStock, {}, {}, "coffee", "capp"); // coffee has milk: 0
    expect(a.ok).toBe(false); expect(a.mode).toBe("Recipe"); expect(a.why).toMatch(/Milk 1L/);
  });
  it("counts portions from the binding ingredient net of reservations", () => {
    const a = availOf(M, seedStock, {}, {}, "rest", "capp"); // rest: milk 14, beans 2, sugar 3, cup 220
    expect(a).toEqual({ ok: true, mode: "Recipe", left: "93 portions" }); // min(14/0.15, 2/0.012, 3/0.006, 220/1) = 93
    expect(availOf(M, seedStock, { "rest:milk": 14 }, {}, "rest", "capp").ok).toBe(false);
  });
  it("a made-to-order item with no recipe is off, and says so rather than throwing", () => {
    expect(availOf({ items: IT, locations: LOC, recipes: {} }, seedStock, {}, {}, "rest", "capp")).toEqual({ ok: false, mode: "Recipe", why: "no recipe recorded" });
  });
  it("a traded item is off at zero", () => { expect(availOf(M, seedStock, {}, {}, "kiosk", "juice")).toEqual({ ok: true, mode: "Stock", left: "14 nos" }); expect(availOf(M, seedStock, {}, {}, "coffee", "milk").ok).toBe(false); });
});
