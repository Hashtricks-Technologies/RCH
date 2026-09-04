import type { Tx } from "../../lib/db.js";

export const productionRepo = { async ping(_tx: Tx): Promise<void> {} };
