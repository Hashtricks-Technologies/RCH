import { sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { appliedMigrationCount, expectedMigrationCount, runMigrations } from "../db/migrate.js";

const config = loadConfig(process.env);
// statementTimeoutMs: 0 - a migration, and a replica waiting its turn on the advisory lock
// below, are both allowed to take longer than the 15 s a request may.
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1, statementTimeoutMs: 0 });
// This CLI runs as an initContainer on every api pod, so several replicas can start it at
// once during a rollout; a Postgres advisory lock makes only one of them actually migrate
// while the rest block here, then find nothing left to apply. `max: 1` above pins the pool
// to a single connection, so the lock/unlock pair below runs on the same session as
// runMigrations - advisory locks are session-scoped, not transaction-scoped.
//
// Waiting for that lock is the whole point of this initContainer, so the wait is unbounded on
// purpose: `lock_timeout = 0` says so explicitly rather than relying on the server's default,
// which a role or database setting could have moved. Set on the session, which `max: 1` makes
// the same session every statement below runs on.
await db.execute(sql`set lock_timeout = 0`);
await db.execute(sql`select pg_advisory_lock(727272)`);
await runMigrations(db);
console.log(`migrations applied: ${await appliedMigrationCount(db)} / ${expectedMigrationCount()}`);
await db.execute(sql`select pg_advisory_unlock(727272)`);
await pool.end();
