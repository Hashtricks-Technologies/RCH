// Recipes: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import { eq } from "drizzle-orm";
import type { Tx } from "../../lib/db.js";
import { items, recipeLines, recipes, users } from "../../db/schema/index.js";

export type ItemRow = typeof items.$inferSelect;

export const recipesRepo = {
  /** The document this write decides is the item's recipe, and the row that stands for it is the
   *  item's own: locking it serialises two saves of one recipe (the second reads the first's
   *  lines, not the ones it replaced) and a save against a retirement of the same item. */
  async lockItem(tx: Tx, it: string): Promise<ItemRow | undefined> {
    const [row] = await tx.select().from(items).where(eq(items.key, it)).for("update");
    return row;
  },

  /** Whether the item already had a recipe — the difference between "added" and "changed" in
   *  the trail and in the sentence the operator reads. */
  async hasRecipe(tx: Tx, it: string): Promise<boolean> {
    const [r] = await tx.select({ key: recipes.itemKey }).from(recipes).where(eq(recipes.itemKey, it));
    return Boolean(r);
  },

  /** The whole recipe, replaced: the old lines out, the head written or re-written, the new lines
   *  in the order the operator listed them (`seq`, which is the order every screen reads). */
  async replace(tx: Tx, it: string, ov: number, lines: readonly { it: string; qty: number }[]): Promise<void> {
    await tx.delete(recipeLines).where(eq(recipeLines.itemKey, it));
    await tx.insert(recipes).values({ itemKey: it, overheadPct: ov })
      .onConflictDoUpdate({ target: recipes.itemKey, set: { overheadPct: ov } });
    await tx.insert(recipeLines).values(lines.map((l, seq) => ({ itemKey: it, ingredientKey: l.it, qty: l.qty, seq })));
  },

  async userName(tx: Tx, id: string): Promise<string> {
    const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },
};
