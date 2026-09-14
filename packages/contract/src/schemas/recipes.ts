import { z } from "zod";
import { RecipeSchema } from "./documents.js";
import { QtySchema } from "./writes.js";

// ---- recipes. The one door a recipe has, besides the seed: `PUT /recipes/:it` replaces an
// item's whole recipe - overhead and every line - because a recipe is read as a whole (a cost, a
// batch, a sale's explosion) and a line-by-line door would leave it half-edited between calls.

/** One ingredient and how much of it goes into one unit. A zero is the service's own sentence
 *  ("Enter a quantity of … above zero"), not a 400 - the same split every other quantity makes. */
export const RecipeLineInputSchema = z.strictObject({ it: z.string().min(1).max(64), qty: QtySchema });
/** The overhead's 0–100% is a rule (`recipeRefusal`, `@rch/domain`), so the schema only keeps
 *  the number finite and bounded; the operator reads the sentence, not a Zod path. */
export const SaveRecipeBodySchema = z.strictObject({
  ov: z.number().finite().min(-1000).max(1000),
  lines: z.array(RecipeLineInputSchema).max(50),
});
/** The recipe as saved, beside the item it belongs to - the same `{ key, … }` envelope
 *  `ItemResultSchema` answers with, since the key is what the caller keys its registry on. */
export const RecipeResultSchema = z.strictObject({ key: z.string(), recipe: RecipeSchema });
