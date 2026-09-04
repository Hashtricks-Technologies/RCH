import type { Db } from "../../db/client.js";
import { withReadTransaction } from "../../lib/db.js";
import * as R from "./repo.js";
/**
 * Four of these are one query each and read straight off the pool. `recipes` is not — `loadRecipes`
 * reads heads and lines separately — so it goes through `withReadTransaction` like every other read
 * that fans out (`lib/db.ts`): one request, one connection. It is the last multi-query read in the
 * API that was still taking two.
 */
export const createMasterService = (db: Db) => ({
  items: () => R.readItems(db), locations: () => R.readLocations(db),
  recipes: () => withReadTransaction(db, (tx) => R.readRecipes(tx)),
  prices: () => R.readPrices(db), menus: () => R.readMenu(db),
});
