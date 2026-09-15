import fp from "fastify-plugin";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { Gauge } from "prom-client";
import { createDb, type Db } from "../db/client.js";
import { appliedMigrationCount, journalLength } from "../db/migrate.js";

declare module "fastify" { interface FastifyInstance { db: Db; pool: Pool } }

/** `db` and `pool` together are a caller's own handle (the test harness); without them the
 *  plugin opens a pool on `searchPath` and closes it again with the app. */
export type DbPluginOptions = { url: string; ssl: boolean; max: number; searchPath: string; auditSchema: string; db?: Db; pool?: Pool };

export default fp<DbPluginOptions>(async (app, opts) => {
  let db = opts.db;
  let pool = opts.pool;
  let owned: Pool | undefined;
  if (!db || !pool) {
    if (db || pool) throw new Error("A supplied database handle must come with the pool behind it.");
    const c = createDb(opts.url, opts.ssl, { max: opts.max, searchPath: opts.searchPath });
    db = c.db;
    pool = owned = c.pool;
  }
  const handle = db;
  const counts = pool;
  app.decorate("db", handle);
  app.decorate("pool", counts);

  // Read at scrape time, not sampled: a gauge that lags hides the exhaustion it exists to show.
  const gauge = (name: string, help: string, read: () => number) =>
    new Gauge({ name, help, registers: [app.metrics.registry], collect() { this.set(read()); } });
  gauge("pg_pool_total", "Connections the pool holds", () => counts.totalCount);
  gauge("pg_pool_idle", "Connections the pool holds that are idle", () => counts.idleCount);
  gauge("pg_pool_waiting", "Requests queued for a connection", () => counts.waitingCount);

  // Three reasons, each one an operator acts on differently, and none of them the driver's own
  // words (a DrizzleQueryError carries SQL, an fs error the image's paths): the database cannot be
  // reached or was never migrated, the image's journal cannot be read, or the schema is behind it.
  app.readiness.addCheck("database", async () => {
    let applied: number;
    try {
      await handle.execute(sql`select 1`);
      applied = await appliedMigrationCount(handle, opts.auditSchema);
    } catch (cause) {
      throw new Error("unreachable or unmigrated", { cause });
    }
    let expected: number;
    try {
      expected = journalLength();
    } catch (cause) {
      throw new Error("migration journal unreadable", { cause });
    }
    if (applied !== expected) throw new Error(`schema at ${applied}/${expected} migrations`);
  });
  // Only the pool this plugin opened is its to close; a supplied one belongs to the caller.
  app.addHook("onClose", async () => { await owned?.end(); });
}, { name: "db", dependencies: ["health", "metrics"] });
