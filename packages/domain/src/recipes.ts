import type { Item, ItemType } from "@rch/contract";

/**
 * Which items carry a recipe, which may go into one, and whether a recipe as written may be saved.
 *
 * Until recipes had a door of their own they arrived only with the seed, so a hospital started
 * clean could list a cappuccino and never sell one: `availOf` reads a made-to-order item with no
 * recipe as "no recipe recorded", and a batch of a finished good with none is refused outright.
 * `PUT /recipes/:it` refuses with `recipeRefusal`, and the kitchen's and the manager's recipe
 * screen greys its Save button with the same answer - two enforcers, one rule.
 */

/** A finished good is batched from its recipe in the kitchen; a made-to-order item is exploded
 *  into its recipe at the counter when it is sold. Nothing else is made from anything. */
export const carriesRecipe = (item: Pick<Item, "t">): boolean => item.t === "FG" || item.t === "MTO";

/** An ingredient has to be something a shelf holds, because a batch and a sale both draw it off
 *  one. A made-to-order item never has a stock line of its own, so a recipe naming one would
 *  draw on a shelf nothing ever fills. */
export const canBeIngredient = (item: Pick<Item, "t">): boolean => item.t !== "MTO";

const TYPE_WORD: Record<ItemType, string> = {
  RAW: "a raw material", PACK: "packaging", MRP: "a traded item with a printed MRP",
  FG: "a finished good", MTO: "made to order",
};

export type RecipeDraft = { ov: number; lines: readonly { it: string; qty: number }[] };

/**
 * Why this recipe cannot be saved for this item, or `null` when it can.
 *
 * `items` is the **live** master - the server passes `loadItems`, which leaves retired lines out,
 * and the browser passes its `activeItems()` - so a retired ingredient reads as one the master
 * does not have, which is exactly how every other rule answers a document naming one.
 *
 * The order is the order an operator fixes things in: the item itself, the overhead, then each
 * line from the top, so the sentence always points at the first thing to change.
 */
export function recipeRefusal(items: Readonly<Record<string, Item>>, it: string, draft: RecipeDraft): string | null {
  const item = items[it];
  if (!item) return `There is no item ${it}.`;
  if (!carriesRecipe(item)) return `${item.n} is ${TYPE_WORD[item.t]} - only a finished good or a made-to-order item has a recipe`;
  if (!(draft.ov >= 0 && draft.ov <= 100)) return "Overhead must be between 0% and 100%";
  if (draft.lines.length === 0) return `Add at least one ingredient to ${item.n}'s recipe`;
  const seen = new Set<string>();
  for (const l of draft.lines) {
    if (l.it === it) return `${item.n} cannot be an ingredient of itself`;
    const g = items[l.it];
    if (!g) return `There is no item ${l.it} to use as an ingredient.`;
    if (!canBeIngredient(g)) return `${g.n} is made to order at the counter - it has no stock for a recipe to draw on`;
    if (seen.has(l.it)) return `${g.n} is on the recipe twice - put it on one line`;
    seen.add(l.it);
    if (!(l.qty > 0)) return `Enter a quantity of ${g.n} above zero`;
  }
  return null;
}
