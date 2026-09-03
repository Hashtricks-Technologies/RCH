// Copy this folder to start a module.
//
// repo.ts: SQL only. No rules, no transaction of its own — service.ts opens the transaction
// and passes it in as `tx`.
import type { Tx } from "../../lib/db.js";

export const templateRepo = {
  /** Placeholder so the template compiles standalone; replace with real reads/writes. */
  async ping(_tx: Tx): Promise<void> {},
};
