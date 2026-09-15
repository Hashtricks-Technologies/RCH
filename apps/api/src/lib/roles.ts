// The API's runtime role: created, given its password and granted by the migrate step - never by
// the API, which runs as that role and so could not. Spec §4; deploy/RUNBOOK.md for the operator's
// side of it.
import { sql } from "drizzle-orm";
import { escapeIdentifier, escapeLiteral } from "pg";
import type { Db } from "../db/client.js";
import { withTransaction } from "./db.js";

export type LoginRole = { name: string; password: string };

/** Named once, so the statements below read as what they do, and so a grep for statements
 *  against the table (scripts/check-boundaries.sh) meets the name in one declaration. */
const OUTBOX = "audit_outbox";

const userOf = (url: string): LoginRole => {
  const u = new URL(url);
  return { name: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
};

/**
 * The role the API is to run as, read off the two URLs the migrate step is handed: the runtime
 * `DATABASE_URL` names it and carries its password; `MIGRATE_DATABASE_URL` is who is migrating.
 *
 * `null` when both name the same user. That is local development and every test suite - one `rch`
 * for everything - and it means "migrate, and leave roles alone": there is nobody to create, and
 * granting a superuser what it already holds would only be noise.
 *
 * A runtime URL naming somebody else must say who and with what password, because the password is
 * set from it. Without one the role would exist with no way in, and the API would fail its first
 * query instead of this deploy step failing with a sentence.
 */
export function roleFromUrls(runtimeUrl: string, migrateUrl: string): LoginRole | null {
  const runtime = userOf(runtimeUrl);
  if (runtime.name === userOf(migrateUrl).name) return null;
  if (!runtime.name) throw new Error("DATABASE_URL names no user - the API's runtime role is read from it");
  if (!runtime.password) throw new Error(`DATABASE_URL names ${runtime.name} but carries no password - the migrate step sets the role's password from it`);
  return runtime;
}

/**
 * Create the role if it is missing, then set its password - on every run, so rotating it is
 * editing the URL and redeploying.
 *
 * The migrate CLI runs this inside its advisory lock, so two replicas never race the existence
 * check. `ALTER ROLE` takes no bind parameters, so the password goes in as an escaped literal, and
 * a failure is re-thrown without the statement: Drizzle's own error quotes the SQL it ran, which
 * here would print the password into the deploy log.
 */
export async function ensureLoginRole(db: Db, role: LoginRole): Promise<void> {
  const name = escapeIdentifier(role.name);
  const { rows } = await db.execute(sql`select 1 from pg_roles where rolname = ${role.name}`);
  if (rows.length === 0) await db.execute(sql.raw(`create role ${name} login`));
  try {
    await db.execute(sql.raw(`alter role ${name} with login password ${escapeLiteral(role.password)}`));
  } catch (err) {
    const code = (err as { cause?: { code?: string } } | null)?.cause?.code ?? "unknown";
    throw new Error(`could not set the password of role ${role.name} (Postgres error ${code})`);
  }
}

/**
 * Everything the API needs and nothing more (spec §4), re-granted on every run so a table a new
 * migration adds is covered in the deploy that brings it:
 *
 * - DML on every table in the app schema and use of its sequences - never TRUNCATE, never DDL;
 * - the same, by default, on tables the migrating role creates there later, as a backstop;
 * - read on the migrations bookkeeping, which `/readyz` counts;
 * - on the audit outbox, INSERT and nothing else. The blanket grant hands it SELECT, UPDATE and
 *   DELETE like any other table, so they are revoked straight after, in the same transaction:
 *   there is no committed moment at which the API's credentials could read or rewrite the log.
 *
 * One transaction, so a failure part-way leaves the previous deploy's grants standing.
 */
export async function grantAppRole(db: Db, role: string, opts: { schema: string; migrationsSchema: string }): Promise<void> {
  const r = escapeIdentifier(role);
  const s = escapeIdentifier(opts.schema);
  const m = escapeIdentifier(opts.migrationsSchema);
  const outbox = `${s}.${escapeIdentifier(OUTBOX)}`;
  await withTransaction(db, async (tx) => {
    const { rows } = await tx.execute<{ seq: string | null }>(sql`select pg_get_serial_sequence(${outbox}, 'id') as seq`);
    const seq = rows[0]?.seq;
    if (!seq) throw new Error(`${opts.schema}.${OUTBOX} has no identity sequence - run the migrations before granting`);
    const statements = [
      `grant usage on schema ${s} to ${r}`,
      `grant select, insert, update, delete on all tables in schema ${s} to ${r}`,
      `grant usage, select on all sequences in schema ${s} to ${r}`,
      `alter default privileges in schema ${s} grant select, insert, update, delete on tables to ${r}`,
      `alter default privileges in schema ${s} grant usage, select on sequences to ${r}`,
      `grant usage on schema ${m} to ${r}`,
      `grant select on ${m}."__drizzle_migrations" to ${r}`,
      `revoke all on table ${outbox} from ${r}`,
      `grant insert on table ${outbox} to ${r}`,
      `revoke all on sequence ${seq} from ${r}`,
      `grant usage on sequence ${seq} to ${r}`,
    ];
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
}

/** The migrate step's whole role setup: nothing when both URLs name the same user; otherwise the
 *  role, its password and its grants. Answers the role it set up, for the CLI's log line. */
export async function applyAppRole(db: Db, urls: { runtime: string; migrate: string }, opts: { schema: string; migrationsSchema: string }): Promise<string | null> {
  const role = roleFromUrls(urls.runtime, urls.migrate);
  if (!role) return null;
  await ensureLoginRole(db, role);
  await grantAppRole(db, role.name, opts);
  return role.name;
}
