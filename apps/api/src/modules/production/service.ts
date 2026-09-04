import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { productionRepo } from "./repo.js";

/** Placeholder so the stub compiles and the graph is connected from the moment it lands.
 *  The module task replaces this with the real service. */
export function createProductionService(db: Db) {
  return { async ready(): Promise<void> { await withTransaction(db, (tx) => productionRepo.ping(tx)); } };
}
