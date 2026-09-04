import fp from "fastify-plugin";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import { appliedMigrationCount, expectedMigrationCount } from "../db/migrate.js";
import { registerPoolGauges } from "../lib/metrics-db.js";

declare module "fastify" { interface FastifyInstance { db: Db } }

/** `db`/`pool` are supplied by tests, which own the handle; without them the plugin opens its own. */
export type DbPluginOptions = { url: string; ssl: boolean; max?: number; searchPath?: string; migrationsSchema?: string; db?: Db; pool?: Pool };

export default fp<DbPluginOptions>(async (app, opts) => {
  let db = opts.db;
  let pool = opts.pool;
  let owned: Pool | undefined;
  if (!db) { const c = createDb(opts.url, opts.ssl, { max: opts.max, searchPath: opts.searchPath }); db = c.db; pool = owned = c.pool; }
  app.decorate("db", db);
  // Whoever opened it, the pool is this process's bottleneck: publish its depth.
  if (pool) registerPoolGauges(app.metrics.registry, pool);
  // The message this check throws is what /readyz prints back (plugins/health.ts), so it is a
  // phrase written for an operator, never the driver's own: a DrizzleQueryError carries the
  // failing SQL, and spec §12 keeps SQL out of responses. Two reasons, and they are the two an
  // operator actually has to tell apart — a database that cannot be reached at all, and one
  // whose schema is behind the image trying to serve from it.
  app.readiness.addCheck("database", async () => {
    let applied: number;
    try {
      await db!.execute(sql`select 1`);
      applied = await appliedMigrationCount(db!, opts.migrationsSchema);
    } catch (cause) {
      throw new Error("unreachable or unmigrated", { cause });
    }
    const expected = expectedMigrationCount();
    if (applied !== expected) throw new Error(`schema at ${applied}/${expected} migrations`);
  });
  // Only the pool this plugin opened is its to close; a supplied one belongs to the caller.
  app.addHook("onClose", async () => { await owned?.end(); });
}, { name: "db", dependencies: ["health", "metrics"] });
