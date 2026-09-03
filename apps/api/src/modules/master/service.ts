import type { Db } from "../../db/client.js";
import * as R from "./repo.js";
export const createMasterService = (db: Db) => ({
  items: () => R.readItems(db), locations: () => R.readLocations(db), recipes: () => R.readRecipes(db), prices: () => R.readPrices(db), menus: () => R.readMenu(db),
});
