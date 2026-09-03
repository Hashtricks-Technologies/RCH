import { sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { appliedMigrationCount, expectedMigrationCount, runMigrations } from "../db/migrate.js";

const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1 });
// This CLI runs as an initContainer on every api pod, so several replicas can start it at
// once during a rollout; a Postgres advisory lock makes only one of them actually migrate
// while the rest block here, then find nothing left to apply. `max: 1` above pins the pool
// to a single connection, so the lock/unlock pair below runs on the same session as
// runMigrations — advisory locks are session-scoped, not transaction-scoped.
await db.execute(sql`select pg_advisory_lock(727272)`);
await runMigrations(db);
console.log(`migrations applied: ${await appliedMigrationCount(db)} / ${expectedMigrationCount()}`);
await db.execute(sql`select pg_advisory_unlock(727272)`);
await pool.end();
