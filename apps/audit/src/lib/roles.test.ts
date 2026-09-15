import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { escapeIdentifier, Pool } from "pg";
import { createDb } from "../db/client.js";
import { appliedMigrationCount, journalLength } from "../db/migrate.js";
import { testConfig } from "../test/config.js";
import { TEST_DATABASE_URL, withAuditSchema, type AuditTestDb } from "../test/db.js";
import { API_MIGRATE_LOCK, migrateAudit } from "./migrate-run.js";
import { ensureLoginRole, roleFromUrls } from "./roles.js";

describe("roleFromUrls", () => {
  it("is null when the runtime and migrate URLs name the same user", () => {
    expect(roleFromUrls("postgres://rch:rch@db:5432/rch", "postgres://rch:other@db:5432/rch")).toBeNull();
  });
  it("reads the runtime user and its decoded password otherwise", () => {
    expect(roleFromUrls("postgres://rch_audit:p%40ss%3Aword@db:5432/rch", "postgres://rch:rch@db:5432/rch")).toEqual({ name: "rch_audit", password: "p@ss:word" });
  });
  it("refuses a runtime URL with no user, or a separate user with no password", () => {
    expect(() => roleFromUrls("postgres://db:5432/rch", "postgres://rch:rch@db:5432/rch")).toThrow("AUDIT_DATABASE_URL names no database user.");
    expect(() => roleFromUrls("postgres://rch_audit@db:5432/rch", "postgres://rch:rch@db:5432/rch")).toThrow("AUDIT_DATABASE_URL gives no password for rch_audit");
  });
});

/** The role is cluster-wide, so its name carries the pid like the schemas do; it is dropped after. */
const ROLE = `t_audit_role_${process.pid}`;
/** A quote and a backslash, so a password that was spliced in unescaped would break the statement. */
const passwordOf = () => `it's\\a-${randomBytes(9).toString("hex")}`;
const urlAs = (user: string, password: string) => {
  const u = new URL(TEST_DATABASE_URL);
  u.username = user;
  u.password = encodeURIComponent(password);
  return u.toString();
};

/** The SQLSTATE a statement fails with, or "ok". */
async function sqlstate(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause;
    return cause?.code ?? (e as { code?: string }).code ?? "unknown";
  }
}
/** The database's sentence for a refused statement, or "ok". */
async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; return "ok"; } catch (e) { return (e as Error).message; }
}

async function dropRole(): Promise<void> {
  const admin = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    const found = await admin.query("select 1 from pg_roles where rolname = $1", [ROLE]);
    if (found.rowCount) {
      await admin.query(`drop owned by ${escapeIdentifier(ROLE)}`);
      await admin.query(`drop role ${escapeIdentifier(ROLE)}`);
    }
  } finally {
    await admin.end();
  }
}

describe("the audit service's database role", () => {
  let t: AuditTestDb;
  let password: string;
  let asRole: Pool;
  let o: string;

  /** The migrate step exactly as the CLI runs it: as the migrate user, one connection, on the audit schema. */
  async function migrateWith(rolePassword: string): Promise<{ applied: number; expected: number; role: string | null }> {
    const config = testConfig({
      AUDIT_DATABASE_URL: urlAs(ROLE, rolePassword), MIGRATE_DATABASE_URL: TEST_DATABASE_URL,
      AUDIT_SCHEMA: t.auditSchema, OUTBOX_SCHEMA: t.outboxSchema, EVENTS_SCHEMA: t.outboxSchema,
    });
    const m = createDb(config.migrateDatabaseUrl, false, { max: 1, searchPath: t.auditSchema, statementTimeoutMs: 0 });
    try { return await migrateAudit(m.db, config, { log: () => {} }); } finally { await m.pool.end(); }
  }

  beforeAll(async () => {
    await dropRole();
    t = await withAuditSchema("roles");
    o = escapeIdentifier(t.outboxSchema);
    // One of the API's own tables, in the schema the outbox shares with them.
    await t.pool.query(`create table ${o}.users (id text primary key, name text not null)`);
    await t.pool.query(`insert into ${o}.users values ('u1', 'Kavitha Raman')`);
    password = passwordOf();
    expect(await migrateWith(password)).toEqual({ applied: journalLength(), expected: journalLength(), role: ROLE });
    asRole = new Pool({ connectionString: urlAs(ROLE, password), max: 1, options: `-c search_path=${t.auditSchema}` });
  });
  afterAll(async () => {
    await asRole?.end();
    await dropRole();
    await t?.close();
  });

  it("logs in with the password from its runtime URL", async () => {
    expect((await asRole.query("select current_user as u")).rows[0].u).toBe(ROLE);
  });

  it("inserts and reads audit events and dead letters", async () => {
    await asRole.query(`insert into events (outbox_id, at, request_id, actor_emp, actor_name, actor_role, actor_loc, action, method, path, outcome, status)
      values (1, now(), 'req-1', 'RC-3120', 'Ramesh Kumar', 'Outlet Manager', 'rest', 'voidBill', 'POST', '/bills/:no/void', 'done', 200)`);
    await asRole.query(`insert into dead_letters (outbox_id, at, event, issue) values (2, now(), '{}', 'actor: Required')`);
    expect((await asRole.query("select count(*)::int as n from events")).rows[0].n).toBe(1);
    expect((await asRole.query("select count(*)::int as n from dead_letters")).rows[0].n).toBe(1);
  });

  it("locks outbox rows with for update skip locked and deletes them, as the drain does", async () => {
    await t.pool.query(`insert into ${o}.audit_outbox (event) values ('{"n":1}'), ('{"n":2}')`);
    const c = await asRole.connect();
    try {
      await c.query("begin");
      const locked = await c.query(`select id from ${o}.audit_outbox order by id limit 500 for update skip locked`);
      expect(locked.rowCount).toBe(2);
      const r = await c.query(`delete from ${o}.audit_outbox where id in (select id from ${o}.audit_outbox order by id limit 500 for update skip locked) returning id, at, event`);
      await c.query("commit");
      expect(r.rowCount).toBe(2);
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
  });

  it("cannot edit or empty the audit tables", async () => {
    expect(await sqlstate(asRole.query("update events set message = 'rewritten'"))).toBe("42501");
    expect(await sqlstate(asRole.query("delete from events"))).toBe("42501");
    expect(await sqlstate(asRole.query("truncate events"))).toBe("42501");
    expect(await sqlstate(asRole.query("update dead_letters set issue = 'fine'"))).toBe("42501");
    expect(await sqlstate(asRole.query("delete from dead_letters"))).toBe("42501");
  });

  it("cannot write the outbox or touch any other table in the API's schema", async () => {
    await t.pool.query(`insert into ${o}.audit_outbox (event) values ('{"n":3}')`);
    // The column grant that lets the drain lock a row cannot change one: the API's trigger refuses it.
    expect(await refusal(asRole.query(`update ${o}.audit_outbox set at = now()`))).toBe("audit_outbox rows are never updated; the audit service moves each one as it was written");
    expect(await sqlstate(asRole.query(`select * from ${o}.users`))).toBe("42501");
    expect(await sqlstate(asRole.query(`insert into ${o}.audit_outbox (event) values ('{}')`))).toBe("42501");
    expect(await sqlstate(asRole.query(`update ${o}.audit_outbox set event = '{}'`))).toBe("42501");
    expect(await sqlstate(asRole.query(`truncate ${o}.audit_outbox`))).toBe("42501");
  });

  it("reads the migrations bookkeeping for /readyz, and PUBLIC holds nothing on the audit schemas", async () => {
    const r = createDb(urlAs(ROLE, password), false, { max: 1, searchPath: t.auditSchema });
    try { expect(await appliedMigrationCount(r.db, t.auditSchema)).toBe(journalLength()); } finally { await r.pool.end(); }
    const acl = await t.pool.query("select nspname, coalesce(nspacl::text, '') as acl from pg_namespace where nspname = any($1)", [[t.auditSchema, `${t.auditSchema}_drizzle`]]);
    expect(acl.rows).toHaveLength(2);
    for (const row of acl.rows as Array<{ acl: string }>) expect(row.acl).not.toMatch(/[{,]=/);
  });

  it("re-runs cleanly and takes a new password from the runtime URL", async () => {
    const next = passwordOf();
    expect((await migrateWith(next)).role).toBe(ROLE);
    const fresh = new Pool({ connectionString: urlAs(ROLE, next), max: 1 });
    const stale = new Pool({ connectionString: urlAs(ROLE, password), max: 1 });
    try {
      expect((await fresh.query("select 1 as ok")).rows[0].ok).toBe(1);
      expect(await sqlstate(stale.query("select 1"))).toBe("28P01");
    } finally {
      await fresh.end();
      await stale.end();
    }
    await asRole.end();
    password = next;
    asRole = new Pool({ connectionString: urlAs(ROLE, password), max: 1, options: `-c search_path=${t.auditSchema}` });
  });

  it("waits for the API's migrate lock before it sets up the role and its grants", async () => {
    const api = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const held = await api.connect();
    try {
      await held.query(`select pg_advisory_lock(${API_MIGRATE_LOCK})`);
      let finished = false;
      const run = migrateWith(password).then((r) => { finished = true; return r; });
      await vi.waitFor(async () => {
        const waiting = await t.pool.query(
          `select count(*)::int as n from pg_locks l join pg_stat_activity a using (pid)
           where l.locktype = 'advisory' and l.objid = $1 and not l.granted and a.application_name = 'rch-audit'`,
          [API_MIGRATE_LOCK],
        );
        expect(waiting.rows[0].n).toBe(1);
      }, { timeout: 10_000, interval: 100 });
      expect(finished).toBe(false);
      await held.query(`select pg_advisory_unlock(${API_MIGRATE_LOCK})`);
      expect((await run).role).toBe(ROLE);
    } finally {
      held.release();
      await api.end();
    }
  });

  it("never puts the password in an error", async () => {
    const secret = passwordOf();
    const m = createDb(TEST_DATABASE_URL, false, { max: 1 });
    try {
      // A read-only session lets the lookup through and refuses the ALTER ROLE that carries the password.
      await m.pool.query("set default_transaction_read_only = on");
      const err = await ensureLoginRole(m.db, { name: ROLE, password: secret }).then(() => null, (e: unknown) => e as Error);
      expect(err?.message).toBe(`Could not set up the login role ${ROLE}: cannot execute ALTER ROLE in a read-only transaction (25006).`);
      expect(`${err?.message} ${String(err?.cause)} ${err?.stack}`).not.toContain(secret.slice(-18));
    } finally {
      await m.pool.end();
    }
  });
});
