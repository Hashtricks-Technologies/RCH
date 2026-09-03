import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { rebuildBalances } from "../lib/ledger.js";

const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1 });
const r = await rebuildBalances(db);
console.log(`stock_balances rebuilt: ${r.rows} rows`);
await pool.end();
