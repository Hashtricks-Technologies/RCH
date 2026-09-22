import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatId, SEQUENCE_START, type IdKind } from "@rch/domain";
import { withTestSchema, type TestDb } from "../test/db.js";
import { allocateId, allocateNumber, ensureSequences } from "./ids.js";
import { withTransaction } from "./db.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("ids"); await withTransaction(t.db, (tx) => ensureSequences(tx)); });
afterAll(async () => { await t.close(); });

describe("allocateId", () => {
  it("continues the seeded series and never repeats under concurrency", async () => {
    const first = await withTransaction(t.db, (tx) => allocateId(tx, "tkt"));
    expect(first).toBe("TKT-0441");
    const ids = await Promise.all(Array.from({ length: 20 }, () => withTransaction(t.db, (tx) => allocateId(tx, "tkt"))));
    expect(new Set(ids).size).toBe(20);
    expect(ids).toContain("TKT-0442");
    expect(ids).toContain("TKT-0461");
  });
  // Relative, not absolute: this file shares one schema and one `sequences` row across its
  // cases, and the case above has already consumed tkt 441-461.
  it("hands back the raw number alongside the id, so the series can be read without parsing", async () => {
    const a = await withTransaction(t.db, (tx) => allocateNumber(tx, "tkt"));
    const b = await withTransaction(t.db, (tx) => allocateNumber(tx, "tkt"));
    expect(b.n).toBe(a.n + 1);
    expect(a.id).toBe(formatId("tkt", a.n));
    expect(b.id).toBe(formatId("tkt", b.n));
    expect(await withTransaction(t.db, (tx) => allocateId(tx, "tkt"))).toBe(formatId("tkt", b.n + 1));
  });
  it("does not consume a number when the transaction rolls back", async () => {
    await expect(withTransaction(t.db, async (tx) => { await allocateId(tx, "bill"); throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withTransaction(t.db, (tx) => allocateId(tx, "bill"))).toBe("CF/1188");
  });
});

describe("migrating initialises every series", () => {
  it("hands out a number for each IdKind on a database nobody has seeded", async () => {
    // The regression this guards. A database is migrated on every deploy and seeded once, if
    // ever, so `ensureSequences` living only in the seed meant a series introduced after a
    // deployment was seeded had no row at all - and the first write of that kind died on
    // "sequence ... is not initialised", a bare 500 rather than a sentence. `settlement`,
    // `adj_req` and `price_list` were each introduced that way, which is why recording a
    // payment on the live box did nothing. `runMigrations` now ensures them, so this schema is
    // migrated and *not* seeded, and every kind still allocates.
    const t2 = await withTestSchema("ids_migrated");
    try {
      for (const kind of Object.keys(SEQUENCE_START) as IdKind[]) {
        const n = await withTransaction(t2.db, (tx) => allocateNumber(tx, kind));
        expect(n.n, kind).toBe(SEQUENCE_START[kind]);
      }
    } finally { await t2.close(); }
  });
});
