import { sql } from "drizzle-orm";
import { escapeIdentifier, escapeLiteral } from "pg";
import type { Db } from "../db/client.js";
import { migrationsSchemaOf } from "../db/migrate.js";

export type LoginRole = { name: string; password: string };

/**
 * The role the service runs as, read from its own runtime URL (AUDIT_DATABASE_URL), or `null` when
 * that URL names the same user as the migrate URL - local development and the test suites, where
 * there is no second role to set up and the migrations alone run (spec §4).
 */
export function roleFromUrls(runtimeUrl: string, migrateUrl: string): LoginRole | null {
  const runtime = new URL(runtimeUrl);
  const name = decodeURIComponent(runtime.username);
  if (!name) throw new Error("AUDIT_DATABASE_URL names no database user.");
  if (name === decodeURIComponent(new URL(migrateUrl).username)) return null;
  if (!runtime.password) throw new Error(`AUDIT_DATABASE_URL gives no password for ${name}, so the migrate step cannot set one.`);
  return { name, password: decodeURIComponent(runtime.password) };
}

/**
 * `create role … login` when the role is missing, then `alter role … password` - on every run, so
 * a rotated password in the runtime URL takes effect at the next deploy. The password travels as an
 * escaped literal (DDL takes no bind parameters) and never reaches a log: a failure is rethrown
 * with the driver's own reason, which names no statement, instead of drizzle's "Failed query: …".
 */
export async function ensureLoginRole(db: Db, role: LoginRole): Promise<void> {
  const ident = escapeIdentifier(role.name);
  try {
    const found = await db.execute(sql`select 1 from pg_roles where rolname = ${role.name}`);
    if (found.rows.length === 0) await db.execute(sql.raw(`create role ${ident} login`));
    await db.execute(sql.raw(`alter role ${ident} with login password ${escapeLiteral(role.password)}`));
  } catch (e) {
    const driver = (e as { cause?: { message?: unknown; code?: unknown } }).cause;
    const why = typeof driver?.message === "string" ? driver.message : "the database refused";
    const code = typeof driver?.code === "string" ? ` (${driver.code})` : "";
    throw new Error(`Could not set up the login role ${role.name}: ${why}${code}.`);
  }
}

/**
 * The `rch_audit` row of spec §4, re-granted on every run so a table a later migration adds is
 * covered. `usage` on the three schemas; `select, insert` on the audit tables and nothing more
 * (their triggers refuse edits even to the owner); `select` on the migrations bookkeeping for
 * /readyz; `select, delete` on the outbox, plus `update` on its `at` column alone, because the
 * drain's `for update skip locked` needs UPDATE privilege on at least one column and Postgres
 * offers no narrower grant - the API's trigger on `audit_outbox` refuses every UPDATE, so the grant
 * can lock a row and never change one. Nothing on any other table in the outbox schema.
 */
export async function grantAuditRole(db: Db, role: string, opts: { auditSchema: string; outboxSchema: string }): Promise<void> {
  const r = escapeIdentifier(role);
  const a = escapeIdentifier(opts.auditSchema);
  const d = escapeIdentifier(migrationsSchemaOf(opts.auditSchema));
  const o = escapeIdentifier(opts.outboxSchema);
  for (const statement of [
    `revoke all on schema ${a}, ${d} from public`,
    `grant usage on schema ${a}, ${d}, ${o} to ${r}`,
    `grant select, insert on ${a}."events", ${a}."dead_letters" to ${r}`,
    `grant select on ${d}."__drizzle_migrations" to ${r}`,
    `grant select, delete on ${o}."audit_outbox" to ${r}`,
    `grant update ("at") on ${o}."audit_outbox" to ${r}`,
  ]) {
    await db.execute(sql.raw(statement));
  }
}
