import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { createDb, type Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import * as schema from "../db/schema/index.js";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";

export type TestDb = { db: Db; pool: Pool; schemaName: string; close(): Promise<void> };

/** Creates schema `t_<name>_<pid>`, migrates into it, returns a Db whose search_path is that schema.
 *  The pid keeps two checkouts running the same file against one database (parallel worktrees
 *  share port 5439) from dropping each other's schema mid-test; `close` drops it again. */
export async function withTestSchema(name: string): Promise<TestDb> {
  const schemaName = `t_${name.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}_${process.pid}`;
  const admin = new Pool({ connectionString: BASE, max: 1 });
  await admin.query(`drop schema if exists "${schemaName}" cascade`);
  await admin.query(`create schema "${schemaName}"`);
  await admin.end();
  const { db, pool } = createDb(BASE, false, { max: 4, searchPath: `${schemaName},public` });
  await runMigrations(db, schemaName);
  return {
    db, pool, schemaName,
    close: async () => {
      await pool.end();
      const admin = new Pool({ connectionString: BASE, max: 1 });
      await admin.query(`drop schema if exists "${schemaName}" cascade`);
      await admin.end();
    },
  };
}

/**
 * Grow the pool to `n` live connections, then hand them straight back.
 *
 * `pg` gives a waiting caller an idle client instead of opening a second one, so two
 * transactions started in the same tick against a pool that has only ever needed one client
 * run back to back — the second does not even reach its BEGIN until the first has committed.
 * A case about two writers racing for the same row then passes whether or not the lock under
 * test exists. Call this before racing anything.
 */
export async function warmPool(t: TestDb, n = 2): Promise<void> {
  const held = await Promise.all(Array.from({ length: n }, () => t.pool.connect()));
  for (const c of held) c.release();
}

/** Empty every business table between tests; keep sequences and migrations. */
export async function truncateAll(db: Db): Promise<void> {
  const names = Object.values(schema)
    .filter((t) => is(t, PgTable))
    .map((t) => getTableName(t))
    .filter((n) => n !== "sequences");
  await db.execute(sql.raw(`truncate table ${names.map((n) => `"${n}"`).join(", ")} restart identity cascade`));
}
