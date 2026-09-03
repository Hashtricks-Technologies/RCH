import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { items, locations, stockMoves } from "../db/schema/index.js";
import { truncateAll, withTestSchema, type TestDb } from "../test/db.js";
import { withTransaction } from "./db.js";
import { postMoves } from "./ledger.js";

const APPEND_ONLY = "stock_moves is append-only; correct with a reversing move";

/** Drizzle wraps a driver error in "Failed query: ..."; the database's own words are the cause. */
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "<the database allowed it>"; } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    return (cause instanceof Error ? cause : e as Error).message;
  }
};

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("ledger_trigger"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => {
  await truncateAll(t.db);
  await t.db.insert(locations).values({ key: "store", name: "Central Store", code: "WH-CS", type: "Store", floor: "B", costCentre: "CC" });
  await t.db.insert(items).values({ key: "milk", code: "RM-1001", name: "Milk 1L", unit: "L", type: "RAW", grp: "Dairy", hsn: "0401", gst: 0 });
  await withTransaction(t.db, (tx) => postMoves(tx, [{ loc: "store", it: "milk", qty: 5, kind: "opening", refType: "seed", refId: "o" }]));
});

describe("the stock ledger is append-only in the database, not only by convention", () => {
  it("refuses an UPDATE and says what to do instead", async () => {
    expect(await refusal(t.db.update(stockMoves).set({ qty: 999 }).where(eq(stockMoves.itemKey, "milk")))).toBe(APPEND_ONLY);
    expect((await t.db.select().from(stockMoves))[0].qty).toBe(5);
  });
  it("refuses a DELETE", async () => {
    expect(await refusal(t.db.delete(stockMoves).where(eq(stockMoves.itemKey, "milk")))).toBe(APPEND_ONLY);
    expect(await t.db.select().from(stockMoves)).toHaveLength(1);
  });
  it("still lets an append through", async () => {
    await withTransaction(t.db, (tx) => postMoves(tx, [{ loc: "store", it: "milk", qty: -1, kind: "ticket_out", refType: "ticket", refId: "TKT-0440" }]));
    expect(await t.db.select().from(stockMoves)).toHaveLength(2);
  });
  it("does not block TRUNCATE, so truncateAll() and a forced reseed still work", async () => {
    await truncateAll(t.db);
    expect(await t.db.select().from(stockMoves)).toHaveLength(0);
  });
});
