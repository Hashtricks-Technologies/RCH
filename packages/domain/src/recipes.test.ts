import { describe, expect, it } from "vitest";
import type { Item } from "@rch/contract";
import { canBeIngredient, carriesRecipe, recipeRefusal } from "./recipes.js";

const item = (n: string, t: Item["t"]): Item => ({ c: "X", n, u: "nos", t, g: "G", hsn: "2106", gst: 5, rl: 0, cost: 1 });
const ITEMS: Record<string, Item> = {
  milk: item("Milk 1L (toned)", "RAW"),
  cup: item("Paper cup 150ml", "PACK"),
  water: item("Mineral water 1L", "MRP"),
  puff: item("Veg puffs", "FG"),
  capp: item("Cappuccino", "MTO"),
  chai: item("Masala tea", "MTO"),
};
const ok = { ov: 12, lines: [{ it: "milk", qty: 0.15 }, { it: "cup", qty: 1 }] };

describe("carriesRecipe / canBeIngredient", () => {
  it("only a finished good or a made-to-order item has a recipe", () => {
    expect(["RAW", "PACK", "MRP", "FG", "MTO"].map((t) => carriesRecipe({ t: t as Item["t"] }))).toEqual([false, false, false, true, true]);
  });
  it("anything a shelf holds may go into one, a made-to-order item may not", () => {
    expect(["RAW", "PACK", "MRP", "FG", "MTO"].map((t) => canBeIngredient({ t: t as Item["t"] }))).toEqual([true, true, true, true, false]);
  });
});

describe("recipeRefusal", () => {
  it("lets a well-formed recipe through, for a made-to-order item and for a finished good", () => {
    expect(recipeRefusal(ITEMS, "capp", ok)).toBeNull();
    expect(recipeRefusal(ITEMS, "puff", { ov: 0, lines: [{ it: "milk", qty: 0.035 }] })).toBeNull();
    expect(recipeRefusal(ITEMS, "puff", { ov: 100, lines: [{ it: "water", qty: 1 }] })).toBeNull();
  });
  it("refuses an item the live master does not have", () => {
    expect(recipeRefusal(ITEMS, "ghost", ok)).toBe("There is no item ghost.");
  });
  it("refuses a recipe on something nobody makes, naming what it is", () => {
    expect(recipeRefusal(ITEMS, "milk", ok)).toBe("Milk 1L (toned) is a raw material — only a finished good or a made-to-order item has a recipe");
    expect(recipeRefusal(ITEMS, "cup", ok)).toBe("Paper cup 150ml is packaging — only a finished good or a made-to-order item has a recipe");
    expect(recipeRefusal(ITEMS, "water", ok)).toBe("Mineral water 1L is a traded item with a printed MRP — only a finished good or a made-to-order item has a recipe");
  });
  it("holds the overhead to 0–100%", () => {
    expect(recipeRefusal(ITEMS, "capp", { ...ok, ov: -1 })).toBe("Overhead must be between 0% and 100%");
    expect(recipeRefusal(ITEMS, "capp", { ...ok, ov: 100.5 })).toBe("Overhead must be between 0% and 100%");
    expect(recipeRefusal(ITEMS, "capp", { ...ok, ov: Number.NaN })).toBe("Overhead must be between 0% and 100%");
  });
  it("needs at least one ingredient", () => {
    expect(recipeRefusal(ITEMS, "capp", { ov: 12, lines: [] })).toBe("Add at least one ingredient to Cappuccino's recipe");
  });
  it("names the first bad line, top down", () => {
    expect(recipeRefusal(ITEMS, "capp", { ov: 12, lines: [{ it: "capp", qty: 1 }] })).toBe("Cappuccino cannot be an ingredient of itself");
    expect(recipeRefusal(ITEMS, "capp", { ov: 12, lines: [{ it: "ghost", qty: 1 }] })).toBe("There is no item ghost to use as an ingredient.");
    expect(recipeRefusal(ITEMS, "capp", { ov: 12, lines: [{ it: "chai", qty: 1 }] })).toBe("Masala tea is made to order at the counter — it has no stock for a recipe to draw on");
    expect(recipeRefusal(ITEMS, "capp", { ov: 12, lines: [{ it: "milk", qty: 0.1 }, { it: "milk", qty: 0.05 }] })).toBe("Milk 1L (toned) is on the recipe twice — put it on one line");
    expect(recipeRefusal(ITEMS, "capp", { ov: 12, lines: [{ it: "milk", qty: 0 }] })).toBe("Enter a quantity of Milk 1L (toned) above zero");
    expect(recipeRefusal(ITEMS, "capp", { ov: 12, lines: [{ it: "cup", qty: 1 }, { it: "milk", qty: -0.1 }] })).toBe("Enter a quantity of Milk 1L (toned) above zero");
  });
});
