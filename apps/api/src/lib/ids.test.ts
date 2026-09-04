import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatId } from "@rch/domain";
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
  it("hands back the raw number alongside the id, so an OTP can be minted from it", async () => {
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
