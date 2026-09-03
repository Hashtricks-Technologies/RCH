import fp from "fastify-plugin";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import { appliedMigrationCount, expectedMigrationCount } from "../db/migrate.js";
import { registerPoolGauges } from "../lib/metrics-db.js";

declare module "fastify" { interface FastifyInstance { db: Db } }

/** `db`/`pool` are supplied by tests, which own the handle; without them the plugin opens its own. */
export type DbPluginOptions = { url: string; ssl: boolean; searchPath?: string; migrationsSchema?: string; db?: Db; pool?: Pool };

export default fp<DbPluginOptions>(async (app, opts) => {
  let db = opts.db;
  let pool = opts.pool;
  let owned: Pool | undefined;
  if (!db) { const c = createDb(opts.url, opts.ssl, { searchPath: opts.searchPath }); db = c.db; pool = owned = c.pool; }
  app.decorate("db", db);
  // Whoever opened it, the pool is this process's bottleneck: publish its depth.
  if (pool) registerPoolGauges(app.metrics.registry, pool);
  app.readiness.addCheck("database", async () => {
    await db!.execute(sql`select 1`);
    const applied = await appliedMigrationCount(db!, opts.migrationsSchema);
    const expected = expectedMigrationCount();
    if (applied !== expected) throw new Error(`schema at ${applied}/${expected} migrations`);
  });
  // Only the pool this plugin opened is its to close; a supplied one belongs to the caller.
  app.addHook("onClose", async () => { await owned?.end(); });
}, { name: "db", dependencies: ["health", "metrics"] });
