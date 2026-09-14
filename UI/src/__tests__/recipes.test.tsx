import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import * as FX from "@rch/contract/fixtures";
import { IT, RCP, hydrateItems } from "../data/master";
import RecipeBook from "../ui/RecipeBook";
import { resetStore, S, as } from "./fixture";

/**
 * The recipe book, from the wire and from the screen. The rule itself (`recipeRefusal`) is pinned
 * in `packages/domain/src/recipes.test.ts` and enforced in `apps/api/src/modules/recipes`; what
 * this file pins is which route the action reaches, what it reads back, and that the editor greys
 * its Save button with the same answer the server would refuse with.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (message: string, status = 422) => json({ error: { code: "rule", message } }, status);

const fetchMock = vi.fn();
type Stubs = Record<string, () => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return make
      ? Promise.resolve(make())
      : Promise.resolve(json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const calls = () => fetchMock.mock.calls.map((c) => {
  const [u, init] = c as [string, RequestInit];
  return { at: `${init.method} ${String(u).split("?")[0]}`, body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown) };
});

beforeEach(() => { resetStore(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("saveRecipe - PUT /recipes/:it", () => {
  const SAVED = { ov: 10, l: [["milk", 0.2], ["cup", 1]] as [string, number][] };

  it("sends the whole recipe, reads the book back, and shows the server's sentence", async () => {
    as("prod");
    const message = "Cappuccino's recipe changed - 2 ingredients, ₹12.12 a unit";
    serve({
      "PUT /api/v1/recipes/capp": () => json({ result: { key: "capp", recipe: SAVED }, changed: ["recipes"], message }),
      "GET /api/v1/recipes": () => json({ ...FX.RCP, capp: SAVED }),
    });

    expect(await S().saveRecipe("capp", { ov: 10, lines: [{ it: "milk", qty: 0.2 }, { it: "cup", qty: 1 }] })).toBe(true);

    expect(calls().map((c) => c.at)).toEqual(["PUT /api/v1/recipes/capp", "GET /api/v1/recipes"]);
    expect(calls()[0].body).toEqual({ ov: 10, lines: [{ it: "milk", qty: 0.2 }, { it: "cup", qty: 1 }] });
    expect(S().toast).toBe(message);
    expect(RCP.capp).toEqual(SAVED);
  });

  it("toasts a refusal in the server's words and leaves the book alone", async () => {
    as("manager");
    const before = RCP.chai;
    serve({ "PUT /api/v1/recipes/chai": () => refusal("Overhead must be between 0% and 100%") });

    expect(await S().saveRecipe("chai", { ov: 150, lines: [{ it: "milk", qty: 0.1 }] })).toBe(false);
    expect(S().toast).toBe("Overhead must be between 0% and 100%");
    expect(RCP.chai).toEqual(before);
    expect(calls().map((c) => c.at)).toEqual(["PUT /api/v1/recipes/chai"]);
  });

  it("names the write that did not land when the connection drops", async () => {
    as("prod");
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await S().saveRecipe("capp", { ov: 10, lines: [{ it: "milk", qty: 0.2 }] })).toBe(false);
    expect(S().toast).toBe("Could not save the recipe - check the connection and try again.");
  });
});

describe("the recipe book screen", () => {
  function mount() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(MemoryRouter, null, createElement(RecipeBook))); });
    return { host, done: () => { act(() => { root.unmount(); }); host.remove(); } };
  }

  it("lists every finished good and made-to-order item, and nothing else", () => {
    as("prod");
    const { host, done } = mount();
    const names = [...host.querySelectorAll("td.nm")].map((td) => td.firstChild?.textContent);
    expect(names).toEqual(["Cappuccino", "Garden salad", "Masala tea", "Veg puffs", "Veg sandwich"]);
    done();
  });

  it("flags an item with no recipe, and greys Save until the recipe is one the server would take", () => {
    as("manager");
    act(() => {
      hydrateItems({ ...IT, filter: { c: "MT-5003", n: "Filter coffee", u: "nos", t: "MTO", g: "Beverage", hsn: "2106", gst: 5, rl: 0, cost: 0 } });
      S().notify("");
    });
    const { host, done } = mount();
    expect(host.textContent).toContain("1 without a recipe");

    const open = host.querySelector<HTMLButtonElement>('button[title="Recipe for Filter coffee"]')!;
    expect(open.textContent).toBe("Write");
    act(() => { open.click(); });

    expect(host.textContent).toContain("Add at least one ingredient to Filter coffee's recipe");
    const saveBtn = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save the first recipe")!;
    expect(saveBtn.disabled).toBe(true);

    // Milk goes on with nothing measured yet, which is the rule's next sentence, not a pass.
    const add = host.querySelector<HTMLSelectElement>('select[aria-label="Add an ingredient to Filter coffee"]')!;
    act(() => {
      add.value = "milk";
      add.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("Enter a quantity of Milk 1L (toned) above zero");
    expect(saveBtn.disabled).toBe(true);
    // A made-to-order item is never offered as an ingredient, and nor is the item itself.
    expect([...add.options].map((o) => o.value)).not.toContain("capp");
    expect([...add.options].map((o) => o.value)).not.toContain("filter");
    done();
  });
});
