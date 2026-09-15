import { escapeIdentifier, Pool } from "pg";
import { createDb, type Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";

export type AuditTestDb = { db: Db; pool: Pool; outboxSchema: string; auditSchema: string; close(): Promise<void> };

/** Spec §2.1's outbox and the trigger that refuses every UPDATE on it, as the API's migration
 *  (0016_audit_outbox) creates them. The audit service never imports apps/api, so the harness keeps this copy: change the
 *  API's DDL and change this with it. */
const outboxDdl = (schema: string) => {
  const s = escapeIdentifier(schema);
  return [
    `create table ${s}.audit_outbox (
      id bigint generated always as identity primary key,
      at timestamptz not null default now(),
      event jsonb not null
    )`,
    `create function ${s}.audit_outbox_no_update() returns trigger as $$
    begin
      raise exception 'audit_outbox rows are never updated; the audit service moves each one as it was written';
    end;
    $$ language plpgsql`,
    `create trigger audit_outbox_no_update before update on ${s}.audit_outbox for each row execute function ${s}.audit_outbox_no_update()`,
  ];
};

/** `t_audit_<name>_<pid>` holds the outbox (and stands in for the API's schema); the audit tables
 *  go in `<that>_a` and drizzle's bookkeeping in `<that>_a_drizzle`. The pid keeps two checkouts
 *  sharing port 5439 apart; the 30-character cap keeps `rch_events_<outbox schema>` inside
 *  Postgres's 63-byte channel name. */
function schemaPair(name: string): { outboxSchema: string; auditSchema: string } {
  const slug = name.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  if (slug.length > 30) throw new Error(`Test schema name "${name}" is longer than 30 characters.`);
  const outboxSchema = `t_audit_${slug}_${process.pid}`;
  return { outboxSchema, auditSchema: `${outboxSchema}_a` };
}

async function asAdmin(fn: (admin: Pool) => Promise<void>): Promise<void> {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try { await fn(admin); } finally { await admin.end(); }
}

/** Creates the schema pair, the outbox and the migrated audit tables, and returns a pool of 4 on
 *  `search_path = <audit schema>` - the service's own shape. `close` ends the pool and drops all three. */
export async function withAuditSchema(name: string): Promise<AuditTestDb> {
  const { outboxSchema, auditSchema } = schemaPair(name);
  const drop = (admin: Pool) => Promise.all(
    [outboxSchema, auditSchema, `${auditSchema}_drizzle`].map((s) => admin.query(`drop schema if exists ${escapeIdentifier(s)} cascade`)),
  ).then(() => undefined);
  await asAdmin(async (admin) => {
    await drop(admin);
    await admin.query(`create schema ${escapeIdentifier(outboxSchema)}`);
    for (const statement of outboxDdl(outboxSchema)) await admin.query(statement);
  });
  const { db, pool } = createDb(TEST_DATABASE_URL, false, { max: 4, searchPath: auditSchema });
  await runMigrations(db, auditSchema);
  return {
    db, pool, outboxSchema, auditSchema,
    close: async () => { await pool.end(); await asAdmin(drop); },
  };
}

/** Inserts `events` into this file's outbox, one row each, in order, the way the API does - but
 *  without the `pg_notify`: a test about wake-ups sends `pg_notify('rch_audit_outbox', '')` itself. */
export async function putOutbox(t: AuditTestDb, events: unknown[]): Promise<void> {
  if (events.length === 0) return;
  const values = events.map((_, i) => `($${i + 1}::jsonb)`).join(", ");
  await t.pool.query(`insert into ${escapeIdentifier(t.outboxSchema)}.audit_outbox (event) values ${values}`, events.map((e) => JSON.stringify(e)));
}

/** Empties the outbox, `events` and `dead_letters` between cases. The append-only triggers refuse
 *  TRUNCATE, so they are switched off and on again inside one transaction, as the owner - which
 *  also proves nothing short of the owner's `alter table` gets past them. */
export async function resetAudit(t: AuditTestDb): Promise<void> {
  const a = escapeIdentifier(t.auditSchema);
  const client = await t.pool.connect();
  try {
    await client.query("begin");
    await client.query(`alter table ${a}.events disable trigger events_append_only`);
    await client.query(`alter table ${a}.dead_letters disable trigger dead_letters_append_only`);
    await client.query(`truncate ${escapeIdentifier(t.outboxSchema)}.audit_outbox, ${a}.events, ${a}.dead_letters restart identity`);
    await client.query(`alter table ${a}.events enable trigger events_append_only`);
    await client.query(`alter table ${a}.dead_letters enable trigger dead_letters_append_only`);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
