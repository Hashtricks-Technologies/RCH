// Availability: SQL only. No rules, no transaction of its own — service.ts passes `tx` in.
import type { Tx } from "../../lib/db.js";

export const availabilityRepo = {
  /** Placeholder so the module compiles standalone; replace with real reads/writes. */
  async ping(_tx: Tx): Promise<void> {},
};
