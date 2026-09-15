import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { resetAudit, TEST_DATABASE_URL, withAuditSchema, type AuditTestDb } from "../test/db.js";
import { createDb } from "./client.js";
import { appliedMigrationCount, journalLength, runMigrations } from "./migrate.js";
import { deadLetters, events } from "./schema.js";

const APPEND_ONLY = (table: string) => `${table} is append-only; the audit log is never edited`;

/** The database's own error, from under drizzle's "Failed query: …" wrapper. */
async function dbError(p: Promise<unknown>): Promise<{ message: string; code?: string; constraint?: string }> {
  try { await p; return { message: "<the database allowed it>" }; } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    const err = (cause instanceof Error ? cause : e) as Error & { code?: string; constraint?: string };
    return { message: err.message, code: err.code, constraint: err.constraint };
  }
}

const row = (outboxId: number) => ({
  outboxId, at: new Date("2026-09-14T04:30:00Z"), requestId: `req-${outboxId}`,
  actorId: "u2", actorEmp: "RC-3120", actorName: "Ramesh Kumar", actorRole: "Outlet Manager", actorLoc: "rest",
  action: "voidBill", method: "POST", path: "/bills/:no/void", outcome: "done" as const, status: 200,
});

let t: AuditTestDb;
beforeAll(async () => { t = await withAuditSchema("storage"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await resetAudit(t); });

describe("the audit migrations", () => {
  it("apply every journal entry, with the bookkeeping in <audit schema>_drizzle", async () => {
    expect(journalLength()).toBeGreaterThanOrEqual(1);
    expect(await appliedMigrationCount(t.db, t.auditSchema)).toBe(journalLength());
    const r = await t.db.execute(sql`select table_schema as s from information_schema.tables where table_name = '__drizzle_migrations' and table_schema like ${`${t.outboxSchema}%`}`);
    expect(r.rows.map((x) => (x as { s: string }).s)).toEqual([`${t.auditSchema}_drizzle`]);
  });

  it("create the audit tables in the audit schema and leave the outbox where the API put it", async () => {
    const at = async (name: string) => (await t.db.execute(sql`select to_regclass(${name}) as r`)).rows[0] as { r: string | null };
    expect((await at(`"${t.auditSchema}".events`)).r).not.toBeNull();
    expect((await at(`"${t.auditSchema}".dead_letters`)).r).not.toBeNull();
    expect((await at(`"${t.outboxSchema}".audit_outbox`)).r).not.toBeNull();
    expect((await at(`"${t.outboxSchema}".events`)).r).toBeNull();
    expect((await at(`"${t.auditSchema}".audit_outbox`)).r).toBeNull();
  });

  it("run again without applying anything twice", async () => {
    await runMigrations(t.db, t.auditSchema);
    expect(await appliedMigrationCount(t.db, t.auditSchema)).toBe(journalLength());
  });

  it("refuse a connection whose search_path would put the tables somewhere else", async () => {
    const stray = `${t.outboxSchema}_x`;
    const { db, pool } = createDb(TEST_DATABASE_URL, false, { max: 1, searchPath: "public" });
    try {
      await expect(runMigrations(db, stray)).rejects.toThrow(`The connection's search_path starts at public, not ${stray}`);
    } finally {
      await pool.query(`drop schema if exists "${stray}" cascade`);
      await pool.end();
    }
  });
});

describe("events", () => {
  it("stores a row with the defaults the drainer relies on", async () => {
    await t.db.insert(events).values(row(1));
    const [stored] = await t.db.select().from(events);
    expect(stored).toMatchObject({ outboxId: 1, target: "", targetLoc: "", message: "", cause: null, request: {}, before: null, result: null, changed: [], ip: "", userAgent: "" });
    expect(stored.storedAt).toBeInstanceOf(Date);
  });

  it("stores one row per outbox id", async () => {
    await t.db.insert(events).values(row(7));
    const e = await dbError(t.db.insert(events).values(row(7)));
    expect(e.code).toBe("23505");
    expect(e.constraint).toBe("events_outbox_id_uq");
  });

  it("refuses an outcome that is not done, refused or error", async () => {
    const e = await dbError(t.db.execute(sql`insert into events (outbox_id, at, request_id, actor_emp, actor_name, actor_role, actor_loc, action, method, path, outcome, status)
      values (8, now(), 'r', 'RC-1', 'n', 'r', 'l', 'a', 'POST', '/x', 'maybe', 200)`));
    expect(e.constraint).toBe("events_outcome_ck");
  });
});

describe("the audit tables are append-only in the database", () => {
  it("refuses UPDATE, DELETE and TRUNCATE on events, even one that matches no row", async () => {
    await t.db.insert(events).values(row(1));
    expect((await dbError(t.db.execute(sql`update events set message = 'rewritten'`))).message).toBe(APPEND_ONLY("events"));
    expect((await dbError(t.db.execute(sql`delete from events where id < 0`))).message).toBe(APPEND_ONLY("events"));
    expect((await dbError(t.db.execute(sql`truncate events`))).message).toBe(APPEND_ONLY("events"));
    expect(await t.db.select().from(events)).toHaveLength(1);
  });

  it("refuses UPDATE, DELETE and TRUNCATE on dead_letters", async () => {
    await t.db.insert(deadLetters).values({ outboxId: 3, at: new Date(), event: { nope: true }, issue: "actor: Required" });
    expect((await dbError(t.db.execute(sql`update dead_letters set issue = 'fine'`))).message).toBe(APPEND_ONLY("dead_letters"));
    expect((await dbError(t.db.execute(sql`delete from dead_letters`))).message).toBe(APPEND_ONLY("dead_letters"));
    expect((await dbError(t.db.execute(sql`truncate dead_letters`))).message).toBe(APPEND_ONLY("dead_letters"));
    expect(await t.db.select().from(deadLetters)).toHaveLength(1);
  });
});

describe("resetAudit", () => {
  it("empties the outbox and both tables, and turns the triggers back on", async () => {
    await t.pool.query(`insert into "${t.outboxSchema}".audit_outbox (event) values ('{}')`);
    await t.db.insert(events).values(row(1));
    await t.db.insert(deadLetters).values({ outboxId: 2, at: new Date(), event: {}, issue: "actor: Required" });
    await resetAudit(t);
    expect(await t.db.select().from(events)).toHaveLength(0);
    expect(await t.db.select().from(deadLetters)).toHaveLength(0);
    expect((await t.pool.query(`select count(*)::int as n from "${t.outboxSchema}".audit_outbox`)).rows[0].n).toBe(0);
    expect((await dbError(t.db.execute(sql`delete from events`))).message).toBe(APPEND_ONLY("events"));
  });
});
