import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestSchema, truncateAll, type TestDb } from "../test/db.js";
import { appendHistory, readHistories, readHistory } from "./history.js";
import { withTransaction } from "./db.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("history"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await truncateAll(t.db); });

describe("appendHistory / readHistory", () => {
  it("round trips: what's appended inside a transaction comes back in order", async () => {
    await withTransaction(t.db, async (tx) => {
      await appendHistory(tx, "req", "REQ-2026-0913", "draft", "E1001", new Date("2026-09-01T00:00:00Z"));
      await appendHistory(tx, "req", "REQ-2026-0913", "approved", "E1002", new Date("2026-09-02T00:00:00Z"));
    });
    const rows = await readHistory(t.db, "req", "REQ-2026-0913");
    expect(rows).toEqual([
      { s: "draft", who: "E1001", t: "2026-09-01T00:00:00.000Z" },
      { s: "approved", who: "E1002", t: "2026-09-02T00:00:00.000Z" },
    ]);
  });
  it("scopes by (docType, docId): a different document's history stays separate", async () => {
    await withTransaction(t.db, async (tx) => {
      await appendHistory(tx, "req", "REQ-1", "draft", "E1001");
      await appendHistory(tx, "req", "REQ-2", "draft", "E1001");
    });
    expect(await readHistory(t.db, "req", "REQ-1")).toHaveLength(1);
    expect(await readHistory(t.db, "req", "REQ-2")).toHaveLength(1);
  });
  it("defaults `at` to now when omitted", async () => {
    const before = Date.now();
    await withTransaction(t.db, (tx) => appendHistory(tx, "req", "REQ-3", "draft", "E1001"));
    const [row] = await readHistory(t.db, "req", "REQ-3");
    expect(Date.parse(row!.t)).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("readHistories", () => {
  it("groups every document's history under one query, keyed by docId", async () => {
    await withTransaction(t.db, async (tx) => {
      await appendHistory(tx, "req", "REQ-1", "draft", "E1001", new Date("2026-09-01T00:00:00Z"));
      await appendHistory(tx, "req", "REQ-1", "approved", "E1002", new Date("2026-09-02T00:00:00Z"));
      await appendHistory(tx, "req", "REQ-2", "draft", "E1001", new Date("2026-09-01T00:00:00Z"));
      // A different docType with the same docId must not bleed into "req"'s map.
      await appendHistory(tx, "po", "REQ-1", "draft", "E1001", new Date("2026-09-01T00:00:00Z"));
    });
    const m = await readHistories(t.db, "req");
    expect(m.get("REQ-1")).toEqual([
      { s: "draft", who: "E1001", t: "2026-09-01T00:00:00.000Z" },
      { s: "approved", who: "E1002", t: "2026-09-02T00:00:00.000Z" },
    ]);
    expect(m.get("REQ-2")).toEqual([{ s: "draft", who: "E1001", t: "2026-09-01T00:00:00.000Z" }]);
    expect(m.size).toBe(2);
  });
});
