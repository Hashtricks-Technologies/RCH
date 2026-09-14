// The recipe book: one write, the same shape every other server-backed action in this store has -
// call, repeat the server's own sentence, refetch what it named.
import { routes } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import type { AppState } from "./index";

type Get = () => AppState;

export interface RecipesSlice {
  /** Form-carrying: answers whether the server took the recipe, so the editor keeps what was
   *  typed on a refusal and lets it go only once the recipe is saved. */
  saveRecipe: (it: string, draft: { ov: number; lines: { it: string; qty: number }[] }) => Promise<boolean>;
}

export const createRecipesSlice = (get: Get): RecipesSlice => ({
  saveRecipe: async (it, { ov, lines }) => {
    try {
      const r = await call(routes.saveRecipe, { params: { it }, body: { ov, lines } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not save the recipe - check the connection and try again.");
      return false;
    }
  },
});
