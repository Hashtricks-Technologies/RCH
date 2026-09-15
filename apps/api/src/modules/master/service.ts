import type { Db } from "../../db/client.js";
import * as R from "./repo.js";
/** Each of these is one query and reads straight off the pool; a read that fans out goes
 *  through `withReadTransaction` instead (`lib/db.ts`): one request, one connection. */
export const createMasterService = (db: Db) => ({
  items: () => R.readItems(db), locations: () => R.readLocations(db),
  prices: () => R.readPrices(db), menus: () => R.readMenu(db),
  priceLists: () => R.readPriceLists(db),
});
