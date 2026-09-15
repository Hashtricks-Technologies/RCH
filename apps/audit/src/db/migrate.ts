import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { escapeIdentifier } from "pg";
import type { Db } from "./client.js";

// src/db/ is two levels below apps/audit; dist/cli/ is two below the image's /app. Walk up from
// this file until a drizzle/meta/_journal.json shows up.
function migrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try { readFileSync(join(dir, "drizzle", "meta", "_journal.json")); return join(dir, "drizzle"); } catch { dir = dirname(dir); }
  }
  throw new Error("drizzle/ migrations folder not found");
}

/** How many migrations this image carries - what /readyz compares the database against. */
export function journalLength(): number {
  const j = JSON.parse(readFileSync(join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
  return j.entries.length;
}

/** Drizzle's bookkeeping schema for an audit schema: `audit_drizzle` in production, apart from the
 *  API's `drizzle`, so neither service's /readyz counts the other's migrations. */
export const migrationsSchemaOf = (auditSchema: string): string => `${auditSchema}_drizzle`;

/**
 * Creates `auditSchema` if it is missing and applies the journal into it. The SQL is unqualified,
 * so `db`'s connections must already have `search_path` starting at `auditSchema`
 * (`createDb(…, { searchPath: auditSchema })`); a connection that does not is refused before
 * anything is created in the wrong schema.
 */
export async function runMigrations(db: Db, auditSchema: string): Promise<void> {
  await db.execute(sql.raw(`create schema if not exists ${escapeIdentifier(auditSchema)}`));
  const r = await db.execute(sql`select current_schema() as s`);
  const current = (r.rows[0] as { s: string | null }).s;
  if (current !== auditSchema) {
    throw new Error(`The connection's search_path starts at ${current ?? "no schema"}, not ${auditSchema}; refusing to migrate into the wrong schema.`);
  }
  await migrate(db, { migrationsFolder: migrationsFolder(), migrationsSchema: migrationsSchemaOf(auditSchema) });
}

/** How many audit migrations this database has applied. Throws when none ever ran. */
export async function appliedMigrationCount(db: Db, auditSchema: string): Promise<number> {
  const r = await db.execute(sql.raw(`select count(*)::int as n from ${escapeIdentifier(migrationsSchemaOf(auditSchema))}."__drizzle_migrations"`));
  return Number((r.rows[0] as { n: number }).n);
}
