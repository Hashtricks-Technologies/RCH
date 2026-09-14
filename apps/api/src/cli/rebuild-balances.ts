import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { rebuildBalances } from "../lib/ledger.js";

const config = loadConfig(process.env);
// statementTimeoutMs: 0 - replaying every stock move into stock_balances scales with the
// ledger, not with a request, and must not be cancelled part-way at fifteen seconds.
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1, statementTimeoutMs: 0 });
const r = await rebuildBalances(db);
console.log(`stock_balances rebuilt: ${r.rows} rows`);
await pool.end();
