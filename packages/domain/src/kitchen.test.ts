import { describe, expect, it } from "vitest";
import { IT } from "@rch/contract/fixtures";
import {
  isKitchenMade, isOnOff, KITCHEN_OFF_REASON, notStockedAtKitchenMessage, onOffRefusal, toOnOffRefusal, usedOnArrival,
  valueAtCost, WASTAGE_REASONS,
} from "./kitchen";

describe("usedOnArrival", () => {
  it("raw materials and packaging are used the moment they land at the kitchen", () => {
    expect(usedOnArrival("RAW", "kitchen")).toBe(true);
    expect(usedOnArrival("PACK", "kitchen")).toBe(true);
  });
  it("a finished good at the kitchen is stocked, and nothing is used on landing anywhere else", () => {
    expect(usedOnArrival("FG", "kitchen")).toBe(false);
    expect(usedOnArrival("MRP", "kitchen")).toBe(false);
    expect(usedOnArrival("RAW", "store")).toBe(false);
    expect(usedOnArrival("PACK", "rest")).toBe(false);
  });
});

describe("counted and on/off-only finished goods", () => {
  it("on/off only is made to order with the kitchen as its source", () => {
    expect(isOnOff(IT.meals)).toBe(true);
    expect(isOnOff(IT.capp)).toBe(false);
    expect(isOnOff({ t: "MTO", src: "store" })).toBe(false);
    expect(isOnOff(IT.puff)).toBe(false);
    expect(isOnOff(undefined)).toBe(false);
  });
  it("the kitchen makes its counted goods and its on/off ones, never a counter's drink", () => {
    expect(isKitchenMade(IT.puff)).toBe(true);
    expect(isKitchenMade(IT.meals)).toBe(true);
    expect(isKitchenMade(IT.capp)).toBe(false);
    expect(isKitchenMade(IT.milk)).toBe(false);
    expect(isKitchenMade(undefined)).toBe(false);
  });
  it("names the item in every refusal", () => {
    expect(KITCHEN_OFF_REASON).toBe("switched off by the kitchen");
    expect(onOffRefusal("Veg meals", "batched")).toBe("Veg meals is on/off only - the kitchen switches it on and off, so it is not batched");
    expect(notStockedAtKitchenMessage("Maida")).toBe("Maida is not stocked at the kitchen - it was used when it arrived; record it as wastage instead");
  });
  it("names every place still holding or carrying a counted good before it may become on/off only", () => {
    expect(toOnOffRefusal("Veg puffs", { held: [], tickets: [], orders: [] })).toBeNull();
    expect(toOnOffRefusal("Veg puffs", { held: ["Central Kitchen", "Restaurant"], tickets: ["TKT-0441"], orders: ["PRD-2026-031", "PRD-2026-032"] }))
      .toBe("Veg puffs cannot become on/off only while there is stock at Central Kitchen, Restaurant and open ticket TKT-0441 and open kitchen orders PRD-2026-031, PRD-2026-032 - sell, write off or finish those first");
    expect(toOnOffRefusal("Veg puffs", { held: [], tickets: ["TKT-1", "TKT-2"], orders: ["PRD-1"] }))
      .toBe("Veg puffs cannot become on/off only while there is open tickets TKT-1, TKT-2 and open kitchen order PRD-1 - sell, write off or finish those first");
  });
});

describe("wastage", () => {
  it("offers the four loss reasons, never a count or a return", () => {
    expect(WASTAGE_REASONS).toEqual(["wastage", "expired", "breakage", "other"]);
  });
  it("values a quantity at cost to the paisa", () => {
    expect(valueAtCost(2.5, 42)).toBe(105);
    expect(valueAtCost(3, 0.62)).toBe(1.86);
    expect(valueAtCost(0.3333, 186)).toBe(61.94);
  });
});
