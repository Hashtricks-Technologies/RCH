import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { appliedMigrationCount, expectedMigrationCount, runMigrations } from "../db/migrate.js";

const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1 });
await runMigrations(db);
console.log(`migrations applied: ${await appliedMigrationCount(db)} / ${expectedMigrationCount()}`);
await pool.end();
