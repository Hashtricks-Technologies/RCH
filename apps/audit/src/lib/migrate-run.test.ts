import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createDb } from "../db/client.js";
import { journalLength } from "../db/migrate.js";
import { testConfig } from "../test/config.js";
import { TEST_DATABASE_URL, withAuditSchema, type AuditTestDb } from "../test/db.js";
import { AUDIT_MIGRATE_LOCK, migrateAudit, OUTBOX_WAIT, OutboxMissingError, outboxExists, waitForOutbox } from "./migrate-run.js";

/** A clock that only moves when the code under test sleeps. */
function fakeClock() {
  let now = 0;
  const slept: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms; }, slept };
}
/** An `exists` that answers from a script, then keeps giving its last answer. */
function answers(...script: boolean[]) {
  let calls = 0;
  const fn = async () => script[Math.min(calls++, script.length - 1)];
  return { fn, calls: () => calls };
}

describe("waitForOutbox", () => {
  it("returns at once when the outbox is already there", async () => {
    const clock = fakeClock();
    const exists = answers(true);
    expect(await waitForOutbox(exists.fn, { timeoutMs: 10_000, intervalMs: 2_000, ...clock })).toBe(true);
    expect(exists.calls()).toBe(1);
    expect(clock.slept).toEqual([]);
  });

  it("looks again every interval until the outbox appears, saying how long it has waited", async () => {
    const clock = fakeClock();
    const exists = answers(false, false, true);
    const waited: number[] = [];
    expect(await waitForOutbox(exists.fn, { timeoutMs: 10_000, intervalMs: 2_000, ...clock, onWait: (ms) => waited.push(ms) })).toBe(true);
    expect(clock.slept).toEqual([2_000, 2_000]);
    expect(waited).toEqual([0, 2_000]);
  });

  it("gives up once the timeout has passed, with a last look at the deadline", async () => {
    const clock = fakeClock();
    const exists = answers(false);
    expect(await waitForOutbox(exists.fn, { timeoutMs: 5_000, intervalMs: 2_000, ...clock })).toBe(false);
    // Looks at 0, 2 and 4 s, sleeps only the 1 s left, and looks once more at 5 s.
    expect(clock.slept).toEqual([2_000, 2_000, 1_000]);
    expect(exists.calls()).toBe(4);
  });

  it("waits five minutes, every two seconds, by default", () => {
    expect(OUTBOX_WAIT).toEqual({ timeoutMs: 300_000, intervalMs: 2_000 });
  });
});

describe("migrateAudit", () => {
  let t: AuditTestDb;
  beforeAll(async () => { t = await withAuditSchema("migrate_run"); });
  afterAll(async () => { await t.close(); });

  it("finds the outbox by schema", async () => {
    expect(await outboxExists(t.db, t.outboxSchema)).toBe(true);
    expect(await outboxExists(t.db, `${t.outboxSchema}_missing`)).toBe(false);
  });

  it("migrates and skips role setup when the runtime user is the migrate user", async () => {
    const config = testConfig({ AUDIT_SCHEMA: t.auditSchema, OUTBOX_SCHEMA: t.outboxSchema, EVENTS_SCHEMA: t.outboxSchema });
    const m = createDb(TEST_DATABASE_URL, false, { max: 1, searchPath: t.auditSchema, statementTimeoutMs: 0 });
    try {
      expect(await migrateAudit(m.db, config, { log: () => {} })).toEqual({ applied: journalLength(), expected: journalLength(), role: null });
    } finally {
      await m.pool.end();
    }
  });

  it("refuses when the outbox never appears, and lets go of the advisory lock", async () => {
    const missing = `${t.outboxSchema}_missing`;
    const config = testConfig({ AUDIT_SCHEMA: t.auditSchema, OUTBOX_SCHEMA: missing, EVENTS_SCHEMA: t.outboxSchema });
    const m = createDb(TEST_DATABASE_URL, false, { max: 1, searchPath: t.auditSchema, statementTimeoutMs: 0 });
    const other = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const lines: string[] = [];
    const clock = fakeClock();
    try {
      const run = migrateAudit(m.db, config, { wait: { timeoutMs: 4_000, intervalMs: 2_000, ...clock }, log: (l) => lines.push(l) });
      await expect(run).rejects.toBeInstanceOf(OutboxMissingError);
      await expect(run).rejects.toThrow(`There is still no ${missing}.audit_outbox after 4 s. Run the API's migrations against this database first.`);
      expect(lines[0]).toBe(`Waiting for ${missing}.audit_outbox, which the API's migrations create (0 s so far).`);
      // The failed run's session is still open, so only its own unlock can have freed the lock.
      const got = await other.query(`select pg_try_advisory_lock(${AUDIT_MIGRATE_LOCK}) as ok`);
      expect(got.rows[0].ok).toBe(true);
      await other.query(`select pg_advisory_unlock(${AUDIT_MIGRATE_LOCK})`);
    } finally {
      await other.end();
      await m.pool.end();
    }
  });
});
