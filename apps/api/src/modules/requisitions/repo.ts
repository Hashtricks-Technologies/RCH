// Requisitions: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import type { Tx } from "../../lib/db.js";

export const requisitionsRepo = {
  /** Placeholder so the skeleton compiles; the module's real reads and writes land next. */
  async ping(_tx: Tx): Promise<void> {},
};
