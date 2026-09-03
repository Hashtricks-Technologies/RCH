import fp from "fastify-plugin";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { createDb } from "../db/client.js";
import { appliedMigrationCount, expectedMigrationCount } from "../db/migrate.js";

declare module "fastify" { interface FastifyInstance { db: Db } }

export type DbPluginOptions = { url: string; ssl: boolean; searchPath?: string; migrationsSchema?: string; db?: Db };

export default fp<DbPluginOptions>(async (app, opts) => {
  let db = opts.db;
  let pool: { end(): Promise<void> } | undefined;
  if (!db) { const c = createDb(opts.url, opts.ssl, { searchPath: opts.searchPath }); db = c.db; pool = c.pool; }
  app.decorate("db", db);
  app.readiness.addCheck("database", async () => {
    await db!.execute(sql`select 1`);
    const applied = await appliedMigrationCount(db!, opts.migrationsSchema);
    const expected = expectedMigrationCount();
    if (applied !== expected) throw new Error(`schema at ${applied}/${expected} migrations`);
  });
  app.addHook("onClose", async () => { await pool?.end(); });
}, { name: "db", dependencies: ["health"] });
