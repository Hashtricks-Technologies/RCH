// Recipes: the flow — transaction, rules. The rule itself is `recipeRefusal` in @rch/domain,
// which the recipe screen previews with; this file only decides in what order it is asked.
import type { z } from "zod";
import type { Recipe, SaveRecipeBodySchema, WriteResponse } from "@rch/contract";
import { money, recipeCost, recipeRefusal, round3 } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { loadItems } from "../../lib/master.js";
import { assertRule } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { recipesRepo } from "./repo.js";

export type SaveRecipeBody = z.infer<typeof SaveRecipeBodySchema>;

const CHANGED = ["recipes"] as const;

export function createRecipesService(db: Db) {
  return {
    /**
     * Replace an item's whole recipe.
     *
     * Lock order is the documents → ids → balances rule with only its first term: the item row
     * is locked, nothing is numbered and nothing moves — a recipe is a promise about future
     * batches and sales, not a movement — so there is no `lockBalances` here, for the same reason
     * `patchItem` and `raise` take none (M12). The trail is the item's own (`document_history`,
     * doc type `item`), beside its `Updated`/`Retired`/`Restored` rows, because a costing that
     * moved is something a manager asking "why did this dish's margin change?" needs to find.
     */
    async save(claims: AccessClaims, it: string, body: SaveRecipeBody): Promise<WriteResponse<{ key: string; recipe: Recipe }>> {
      return withTransaction(db, async (tx) => {
        const row = await recipesRepo.lockItem(tx, it);
        // The same sentence `savePrice` and `patchItem` give, word for word.
        if (!row) throw new NotFoundError(`There is no item ${it}.`);
        assertRule(row.active, `${row.name} is retired — restore it before changing its recipe`);

        const lines = body.lines.map((l) => ({ it: l.it, qty: round3(l.qty) }));
        const items = await loadItems(tx);
        const refusal = recipeRefusal(items, it, { ov: body.ov, lines });
        assertRule(!refusal, refusal ?? "");

        const had = await recipesRepo.hasRecipe(tx, it);
        await recipesRepo.replace(tx, it, body.ov, lines);
        await appendHistory(tx, "item", it, had ? "Recipe changed" : "Recipe added", await recipesRepo.userName(tx, claims.sub));
        await emitChanged(tx, CHANGED);

        const recipe: Recipe = { ov: body.ov, l: lines.map((l) => [l.it, l.qty] as [string, number]) };
        const unit = recipeCost({ items, locations: {}, recipes: { [it]: recipe } }, it);
        const n = lines.length;
        return {
          result: { key: it, recipe },
          changed: [...CHANGED],
          message: `${row.name}'s recipe ${had ? "changed" : "saved"} — ${n} ingredient${n === 1 ? "" : "s"}, ${money(unit)} a unit`,
        };
      });
    },
  };
}
