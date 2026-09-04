// Reports: the two figures the browser cannot compute from its own snapshot — the central store's
// stock ledger, which needs `stock_moves`, and a staff member's credit for the calendar month,
// which needs every outlet's bills and not the till's own seven days. Task 6 fills this in; the
// module is registered empty so `modules/index.ts` is written once, in one wave, by one task.
//
// service.ts: the flow — transaction, rules, moves, history, id. Compose the helpers in
// apps/api/src/lib/ (withTransaction, allocateId, postMoves, appendHistory, assertRule,
// requireLoc); never reimplement them. Domain rules belong in packages/domain, not inlined here.
import type { Db } from "../../db/client.js";
import { reportsRepo } from "./repo.js";

/** Empty until Task 6 adds the two queries (the stock ledger, a month's staff credit). `db`
 *  and `reportsRepo` are already wired in so that work is adding methods to the object below,
 *  not connecting the module's four files from nothing — `reportsRepo` has no other caller
 *  yet, so a bare `import` with no reference would leave `repo.ts` an unimported file. */
export function createReportsService(db: Db): Record<string, never> {
  void db;
  void reportsRepo;
  return {};
}
