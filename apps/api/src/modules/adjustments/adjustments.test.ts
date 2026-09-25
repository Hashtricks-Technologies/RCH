import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { resetDocuments, truncateAll, warmPool } from "../../test/db.js";
import { adjustmentLines, adjustments, documentHistory, stockBalances, stockMoves } from "../../db/schema/index.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => {
  app = await buildTestApp({ schema: "adjustments" });
  await app.ready();
  await truncateAll(app.testDb!.db);
  await seedTestDb(app.testDb!.db);
});
afterAll(async () => { await app.close(); });
// Master data, users and payers are seeded once above; every case starts from a clean set of
// documents and a freshly rebuilt opening ledger.
beforeEach(async () => { await resetDocuments(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/v1/adjustments", headers: await hdr(user), payload });

/** The balance row itself, so quarantine - which no `GET /stock` cut hides, but which the
 *  fixtures leave empty - can be read the same way the five working shelves are. */
const balance = async (loc: string, it: string): Promise<number | undefined> => {
  const [row] = await app.testDb!.db.select().from(stockBalances)
    .where(and(eq(stockBalances.loc, loc), eq(stockBalances.itemKey, it)));
  return row?.onHand;
};
const movesFor = async (id: string) =>
  app.testDb!.db.select().from(stockMoves).where(and(eq(stockMoves.refType, "adjustment"), eq(stockMoves.refId, id)));
const register = async (user = "u3") =>
  (await app.inject({ method: "GET", url: "/api/v1/adjustments", headers: await authHeaders(app, user) })).json();
const snap = async (user: string) =>
  (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, user) })).json();

describe("POST /adjustments", () => {
  it("writes off stock and moves the balance down by exactly what was written off", async () => {
    // The central store carries 12 L of milk at the fixtures' opening.
    const before = await balance("store", "milk");
    const r = await post("u3", { loc: "store", reason: "wastage", note: "Crate went over overnight", lines: [{ it: "milk", qty: -2.5 }] });

    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.lines).toEqual([{ it: "milk", qty: -2.5 }]);
    expect(b.result.loc).toBe("store");
    expect(b.result.reason).toBe("wastage");
    expect(b.result.note).toBe("Crate went over overnight");
    expect(b.result.by).toBe("Suresh Muthu");
    expect(await balance("store", "milk")).toBe(before! - 2.5);
    expect(b.message).toBe(`${b.result.id} - 2.500 L written off at Central Store (wastage)`);
  });

  it("counts up stock, creating the balance row when the location never carried the line", async () => {
    // Nothing has ever been turned away in the demo hospital, so quarantine carries no butter
    // row at all - not a zero, no row. A count-up is the operator saying the shelf carries it.
    expect(await balance("quarantine", "butter")).toBeUndefined();

    const r = await post("u3", { loc: "quarantine", reason: "count", lines: [{ it: "butter", qty: 1.5 }] });
    expect(r.statusCode, r.body).toBe(200);
    expect(await balance("quarantine", "butter")).toBe(1.5);
    expect(r.json().message).toBe(`${r.json().result.id} - 1.500 kg counted up at Quarantine`);
  });

  it("numbers the document ADJ-yyyy-nnnn and steps the series by one", async () => {
    const a = (await post("u3", { loc: "store", reason: "breakage", lines: [{ it: "cup", qty: -10 }] })).json().result.id;
    const b = (await post("u3", { loc: "store", reason: "breakage", lines: [{ it: "cup", qty: -10 }] })).json().result.id;
    // `sequences` survives truncation between files, so the literal number is not assertable -
    // the shape and the step of one are.
    expect(a).toMatch(/^ADJ-\d{4}-\d{4}$/);
    expect(b).toMatch(/^ADJ-\d{4}-\d{4}$/);
    const n = (id: string) => Number(id.slice(-4));
    expect(n(b)).toBe(n(a) + 1);
  });

  it("folds a repeated item into one line before the cover check", async () => {
    // 3.2 kg of tea leaf at the central store. Checked one line at a time, the first −3 would
    // pass and the second would be refused against 0.2 left; folded, the pair is a −1 the shelf
    // covers easily, and one line is what a −3 and a +2 on the same item actually mean.
    const before = await balance("store", "leaf");
    const r = await post("u3", { loc: "store", reason: "count", lines: [{ it: "leaf", qty: -3 }, { it: "leaf", qty: 2 }] });

    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.lines).toEqual([{ it: "leaf", qty: -1 }]);
    expect(await balance("store", "leaf")).toBe(before! - 1);
    expect(await movesFor(r.json().result.id)).toHaveLength(1);
    const rows = await app.testDb!.db.select().from(adjustmentLines).where(eq(adjustmentLines.adjustmentId, r.json().result.id));
    expect(rows).toHaveLength(1);
  });

  it("refuses a line that folds to zero, and an adjustment with nothing on it", async () => {
    const nothing = await post("u3", { loc: "store", reason: "count", lines: [{ it: "milk", qty: 0 }] });
    expect(nothing.statusCode).toBe(422);
    expect(nothing.json().error.message).toBe("Enter a quantity to write off or count up on at least one line");

    // Typed and then undone on the same item: the two halves cancel, so there is nothing left
    // to explain and nothing to write.
    const undone = await post("u3", { loc: "store", reason: "count", lines: [{ it: "milk", qty: -2 }, { it: "milk", qty: 2 }] });
    expect(undone.statusCode).toBe(422);
    expect(undone.json().error.message).toBe("Enter a quantity to write off or count up on at least one line");
    expect(await app.testDb!.db.select().from(adjustments)).toHaveLength(0);
  });

  it("refuses a line naming an item the master does not have", async () => {
    // A stale tab holding a key that was withdrawn, or a client that made one up. It is a 404
    // with the key in it, not a 500 halfway through the write - and nothing is written.
    const r = await post("u3", { loc: "store", reason: "wastage", lines: [{ it: "milk", qty: -1 }, { it: "unicorn", qty: -1 }] });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no item unicorn.");
    expect(await app.testDb!.db.select().from(adjustments)).toHaveLength(0);
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refType, "adjustment"))).toHaveLength(0);
  });

  it("refuses a write-off of more than is free - stock a ticket is holding is not the store's to write off", async () => {
    // 4 kg of butter on the shelf, 3 of them held for a ticket the kitchen has not collected.
    // The books say four; only one is the store's to destroy.
    await given.ticket(app.testDb!.db, { from: "store", to: "kitchen", lines: [{ it: "butter", qty: 3 }] });
    const before = await balance("store", "butter");

    const r = await post("u3", { loc: "store", reason: "expired", lines: [{ it: "butter", qty: -2 }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Cannot write off 2.000 kg of Butter, salted - Central Store has only 1.000 kg free");
    expect(await balance("store", "butter")).toBe(before);
  });

  it("names the first short item and the shortfall, and moves nothing", async () => {
    // Two short lines; the store keeper is told about the first one in the order they typed it,
    // which is the line their own screen is pointing at.
    const before = { milk: await balance("store", "milk"), leaf: await balance("store", "leaf") };
    const r = await post("u3", { loc: "store", reason: "wastage", lines: [{ it: "milk", qty: -99 }, { it: "leaf", qty: -99 }] });

    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Cannot write off 99.000 L of Milk 1L (toned) - Central Store has only 12.000 L free");
    expect(await balance("store", "milk")).toBe(before.milk);
    expect(await balance("store", "leaf")).toBe(before.leaf);
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refType, "adjustment"))).toHaveLength(0);
  });

  it("posts one adjustment move per line and leaves reverses_id null, count included", async () => {
    const r = await post("u3", { loc: "store", reason: "count", lines: [{ it: "milk", qty: -1 }, { it: "sugar", qty: 3 }] });
    expect(r.statusCode, r.body).toBe(200);

    const moves = await movesFor(r.json().result.id);
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => m.kind === "adjustment")).toBe(true);
    expect(moves.map((m) => m.qty).sort((a, b) => a - b)).toEqual([-1, 3]);
    expect(moves.every((m) => m.byUser === "u3")).toBe(true);
    // A count corrects a sum, not one named move - there is nothing for a reversal to point at,
    // and pointing at the most recent move would read as "this undid that", which is not what a
    // physical count found.
    expect(moves.every((m) => m.reversesId === null)).toBe(true);
  });

  it("rolls the whole document back when a later line is refused", async () => {
    const before = await balance("store", "sugar");
    const r = await post("u3", { loc: "store", reason: "wastage", lines: [{ it: "sugar", qty: -5 }, { it: "milk", qty: -99 }] });

    expect(r.statusCode).toBe(422);
    // The good line did not land: one transaction, one refusal, nothing half-written.
    expect(await balance("store", "sugar")).toBe(before);
    expect(await app.testDb!.db.select().from(adjustments)).toHaveLength(0);
    expect(await app.testDb!.db.select().from(adjustmentLines)).toHaveLength(0);
    expect(await app.testDb!.db.select().from(documentHistory).where(eq(documentHistory.docType, "adjustment"))).toHaveLength(0);
  });

  it("lets the store keeper adjust quarantine, and refuses every other role there", async () => {
    // What a goods receipt turned away sits here until somebody destroys it or sends it back;
    // the central store is where it physically is, so the store keeper is who can act on it.
    const ok = await post("u3", { loc: "quarantine", reason: "returned_to_vendor", lines: [{ it: "milk", qty: 2 }] });
    expect(ok.statusCode, ok.body).toBe(200);

    const kitchen = await post("u4", { loc: "quarantine", reason: "returned_to_vendor", lines: [{ it: "milk", qty: -1 }] });
    expect(kitchen.statusCode).toBe(403);
  });

  it("keeps the store keeper to the central store and quarantine - never the kitchen or an outlet", async () => {
    for (const loc of ["kitchen", "rest", "coffee", "kiosk"]) {
      const before = await balance(loc, "milk");
      const r = await post("u3", { loc, reason: "wastage", lines: [{ it: "milk", qty: 1 }] });
      expect(r.statusCode, loc).toBe(403);
      expect(r.json().error.message).toBe("You can only do this for the Central Store or quarantine.");
      expect(await balance(loc, "milk")).toBe(before);
    }
    expect(await app.testDb!.db.select().from(adjustments)).toHaveLength(0);
  });

  it("is absent for the manager - an outlet's shelf is only corrected through an adjustment request", async () => {
    const r = await post("u2", { loc: "kiosk", reason: "breakage", lines: [{ it: "water", qty: -2 }] });
    expect(r.statusCode).toBe(404);
  });

  it("lets the kitchen adjust the kitchen and nowhere else", async () => {
    const before = await balance("kitchen", "maida");
    const ok = await post("u4", { loc: "kitchen", reason: "expired", lines: [{ it: "maida", qty: -1 }] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await balance("kitchen", "maida")).toBe(before! - 1);

    const outlet = await post("u4", { loc: "rest", reason: "expired", lines: [{ it: "milk", qty: -1 }] });
    expect(outlet.statusCode).toBe(403);
    expect(outlet.json().error.message).toBe("You can only do this for the Central Kitchen.");
  });

  it("is absent for a counter operator", async () => {
    // Role decides whether the route exists for you, the same way the sidebar does - a counter
    // does not write stock off, they ask the shop or the store, so this is a 404 and not a 403.
    const r = await post("u1", { loc: "coffee", reason: "wastage", lines: [{ it: "cup", qty: -1 }] });
    expect(r.statusCode).toBe(404);
  });

  it("writes a document_history row naming the reason", async () => {
    const r = await post("u3", { loc: "store", reason: "returned_to_vendor", lines: [{ it: "bisc", qty: -6 }] });
    expect(r.statusCode, r.body).toBe(200);

    const rows = await app.testDb!.db.select().from(documentHistory)
      .where(and(eq(documentHistory.docType, "adjustment"), eq(documentHistory.docId, r.json().result.id)));
    expect(rows).toHaveLength(1);
    // An adjustment has no lifecycle to walk - it happened once - so the word worth recording is
    // why the shelf changed, not a status.
    expect(rows[0].status).toBe("Returned to vendor");
    expect(rows[0].who).toBe("Suresh Muthu");
  });

  it("announces stock and adjustments, and the response carries the same array", async () => {
    const r = await post("u3", { loc: "store", reason: "wastage", lines: [{ it: "bread", qty: -2 }] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().changed).toEqual(["stock", "adjustments"]);
  });

  it("shows a counter only its own location's adjustments", async () => {
    await given.adjustment(app.testDb!.db, { loc: "coffee", lines: [{ it: "cup", qty: -4 }] });
    await given.adjustment(app.testDb!.db, { loc: "kiosk", lines: [{ it: "water", qty: -1 }] });
    await given.adjustment(app.testDb!.db, { loc: "store", lines: [{ it: "milk", qty: -1 }] });

    // u1 is on the Coffee Shop; u3 keeps the central store and sees the register whole.
    const mine = await register("u1");
    expect(mine.map((a: { loc: string }) => a.loc)).toEqual(["coffee"]);
    expect((await register("u3"))).toHaveLength(3);
    // The snapshot makes the same cut, so a screen that reads either one agrees with the other.
    expect((await snap("u1")).adjustments.map((a: { loc: string }) => a.loc)).toEqual(["coffee"]);
    expect((await snap("u3")).adjustments).toHaveLength(3);
  });

  it("two write-offs of the last unit: one lands, the other is refused", async () => {
    await warmPool(app.testDb!, 2);
    // 1.2 kg of butter in the kitchen. Two write-offs of 1 kg, in flight together.
    //
    // What this pins is the pair of balance guards together - `lockBalances` before the cover
    // check, and the post-lock re-read after `postMoves` - not either one alone. Measured, not
    // assumed: deleting the `lockBalances` call on its own leaves the case green, because
    // `postMoves` takes the same row locks itself and the re-read then refuses the second
    // writer with the very same sentence. Disarm **both** and the case goes red with
    // `[200, 200]` and a kitchen shelf at −0.8 kg, which is the failure it exists to catch.
    //
    // It only has that much teeth because `allocateId` is taken late. While the id was the
    // first statement of the transaction, the second POST blocked on the `adj` sequence row
    // before it ever read a balance - and this case passed with both balance guards deleted,
    // which is a race test proving nothing at all.
    const both = await Promise.all([
      post("u4", { loc: "kitchen", reason: "wastage", lines: [{ it: "butter", qty: -1 }] }),
      post("u4", { loc: "kitchen", reason: "wastage", lines: [{ it: "butter", qty: -1 }] }),
    ]);
    const codes = both.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 422]);
    expect(both.find((r) => r.statusCode === 422)!.json().error.message)
      .toBe("Cannot write off 1.000 kg of Butter, salted - Central Kitchen has only 0.200 kg free");
    expect(await balance("kitchen", "butter")).toBe(0.2);
  });
});
