import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { journalLength } from "../db/migrate.js";
import { buildTestApp } from "../test/app.js";
import { testConfig } from "../test/config.js";

/** `journalLength` reads drizzle/meta/_journal.json off the image's disk with no knob to point it
 *  elsewhere, so the "journal unreadable" branch makes that one function throw. Everything else in
 *  the module stays real - the harness migrates with it. */
const journal = vi.hoisted(() => ({ fails: false }));
vi.mock("../db/migrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/migrate.js")>();
  return {
    ...actual,
    journalLength: () => {
      if (journal.fails) throw new Error("ENOENT: no such file or directory, open '/app/drizzle/meta/_journal.json'");
      return actual.journalLength();
    },
  };
});

let app: Awaited<ReturnType<typeof buildTestApp>>;
// `drainer: true` so that, once plugins/drainer.ts gates readiness too, a ready app here still means ready.
beforeAll(async () => { app = await buildTestApp({ schema: "db", drainer: true }); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("the database readiness check", () => {
  it("is ready on a migrated schema, and publishes the pool's depth", async () => {
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    const m = await app.inject({ method: "GET", url: "/metrics" });
    expect(m.body).toContain("pg_pool_total");
    expect(m.body).toContain("pg_pool_waiting");
  });

  it("names an unreadable journal without printing the image's paths", async () => {
    journal.fails = true;
    try {
      const r = await app.inject({ method: "GET", url: "/readyz" });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.message).toContain("database - migration journal unreadable");
      expect(r.body).not.toContain("_journal.json");
    } finally {
      journal.fails = false;
    }
  });

  it("names a database it cannot read migrations from, without the SQL", async () => {
    const bare = await buildApp(testConfig({ AUDIT_SCHEMA: `t_audit_none_${process.pid}` }), { drainer: false });
    try {
      const r = await bare.inject({ method: "GET", url: "/readyz" });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.message).toContain("database - unreachable or unmigrated");
      expect(r.body).not.toContain("__drizzle_migrations");
    } finally {
      await bare.close();
    }
  });

  it("refuses a database handle that comes without its pool", async () => {
    await expect(buildApp(testConfig(), { db: app.testDb.db, drainer: false })).rejects.toThrow("A supplied database handle must come with the pool behind it.");
  });

  // Last, and destructive: empties this file's own bookkeeping, which is what a pod started against a
  // database its image has outrun looks like. The schemas are this file's alone and dropped on close.
  it("says how far behind the schema is", async () => {
    await app.testDb.pool.query(`delete from "${app.testDb.auditSchema}_drizzle"."__drizzle_migrations"`);
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.message).toContain(`database - schema at 0/${journalLength()} migrations`);
  });
});
