import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client.js";

// src/db/ is two levels below apps/api (apps/api/src/db); dist/ is one level below
// (apps/api/dist). Walk up from this file until a drizzle/meta/_journal.json shows up.
export function migrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try { readFileSync(join(dir, "drizzle", "meta", "_journal.json")); return join(dir, "drizzle"); } catch { dir = dirname(dir); }
  }
  throw new Error("drizzle/ migrations folder not found");
}
export function expectedMigrationCount(): number {
  const j = JSON.parse(readFileSync(join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
  return j.entries.length;
}
export async function runMigrations(db: Db, schemaName?: string): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder(), migrationsSchema: schemaName ?? "drizzle" });
}
/** How many migrations this database has applied — compared with the journal by /readyz. */
export async function appliedMigrationCount(db: Db, schemaName = "drizzle"): Promise<number> {
  const r = await db.execute(sql.raw(`select count(*)::int as n from "${schemaName}"."__drizzle_migrations"`));
  return Number((r.rows[0] as { n: number }).n);
}
