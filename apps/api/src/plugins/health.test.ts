import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { buildTestApp } from "../test/app.js";
import { expectedMigrationCount } from "../db/migrate.js";
import type { App } from "../app.js";

/** `expectedMigrationCount` reads `drizzle/meta/_journal.json` off the image's own disk and has no
 *  env knob pointing it elsewhere, so the "journal unreadable" branch is reached by making that one
 *  function throw. Everything else in the module — `runMigrations`, which the harness itself uses —
 *  stays real. `vi.hoisted` because a `vi.mock` factory is lifted above the imports. */
const journal = vi.hoisted(() => ({ fails: false }));
vi.mock("../db/migrate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/migrate.js")>();
  return {
    ...actual,
    expectedMigrationCount: () => {
      if (journal.fails) throw new Error("ENOENT: no such file or directory, open '/app/drizzle/meta/_journal.json'");
      return actual.expectedMigrationCount();
    },
  };
});

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "health" }); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("GET /readyz", () => {
  it("is ready on a migrated schema", async () => {
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("names an unreadable journal without printing the image's own paths", async () => {
    journal.fails = true;
    try {
      const r = await app.inject({ method: "GET", url: "/readyz" });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({
        error: { code: "not_ready", message: "Not ready: database — migration journal unreadable." },
      });
      // The whole point of the wrapper: the fs error's own message names a path inside the
      // container, and spec §12 keeps that class of detail in the log rather than the body.
      expect(r.json().error.message).not.toContain("_journal.json");
    } finally {
      journal.fails = false;
    }
  });

  // Deliberately last, and destructive: it empties this file's own schema's migrations journal,
  // which is what a pod started against a database an image has outrun actually looks like. The
  // schema is this file's alone and is dropped on close, so nothing else sees it.
  it("says why it is not ready when the schema is behind, not just that it is not", async () => {
    const schema = app.testDb!.schemaName;
    await app.testDb!.db.execute(sql.raw(`delete from "${schema}"."__drizzle_migrations"`));

    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    // The count comes from the journal, not from a number typed in here: a seventh migration
    // must not turn this case red for a reason that has nothing to do with readiness.
    expect(r.json()).toEqual({
      error: { code: "not_ready", message: `Not ready: database — schema at 0/${expectedMigrationCount()} migrations.` },
    });
    // The bare `catch` this replaced threw the reason away, and an operator watching a rollout
    // that never goes Ready read only "Not ready: database." — true, and no use.
    expect(r.json().error.message).not.toBe("Not ready: database.");
  });
});
