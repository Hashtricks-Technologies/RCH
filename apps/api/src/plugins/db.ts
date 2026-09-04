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
  // failing SQL and an fs error carries the image's own paths, and spec §12 keeps both out of
  // responses. Three reasons, and they are the three an operator has to act on differently — a
  // database that cannot be reached, an image whose migration journal is not readable, and a
  // schema behind the image trying to serve from it. Nothing that can throw is left outside a
  // `try`: `expectedMigrationCount` reads `drizzle/meta/_journal.json` off disk and would
  // otherwise put `ENOENT … /app/drizzle/meta/_journal.json` into the body.
  app.readiness.addCheck("database", async () => {
    let applied: number;
    try {
      await db!.execute(sql`select 1`);
      applied = await appliedMigrationCount(db!, opts.migrationsSchema);
    } catch (cause) {
      throw new Error("unreachable or unmigrated", { cause });
    }
    let expected: number;
    try {
      expected = expectedMigrationCount();
    } catch (cause) {
      throw new Error("migration journal unreadable", { cause });
    }
    if (applied !== expected) throw new Error(`schema at ${applied}/${expected} migrations`);
  });
  // Only the pool this plugin opened is its to close; a supplied one belongs to the caller.
  app.addHook("onClose", async () => { await owned?.end(); });
}, { name: "db", dependencies: ["health", "metrics"] });
