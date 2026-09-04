// Reports: the two figures the browser cannot compute from its own snapshot — the central store's
// stock ledger, which needs `stock_moves`, and a staff member's credit for the calendar month,
// which needs every outlet's bills and not the till's own seven days. Task 6 fills this in; the
// module is registered empty so `modules/index.ts` is written once, in one wave, by one task.
//
// repo.ts: SQL only. No rules, no transaction of its own — service.ts opens the transaction
// and passes it in as `tx`.
import type { Tx } from "../../lib/db.js";

export const reportsRepo = {
  /** Placeholder so the module compiles standalone; replaced with real reads by Task 6. */
  async ping(_tx: Tx): Promise<void> {},
};
