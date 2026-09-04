import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { istDate, round3 } from "@rch/domain";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll, warmPool } from "../../test/db.js";
import { rebuildBalances } from "../../lib/ledger.js";
import { grns, stockBalances, stockMoves } from "../../db/schema/index.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "grn" }); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: await hdr(user), payload });

/** The documents are read back through `GET /snapshot`, which has been there since Phase 1 —
 *  the six standalone procurement GETs land with the reads task and are asserted in its suite. */
const snap = async (user = "u5") => (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, user) })).json();
const prqs = async () => (await snap()).prq;
/** What a requisition line still wants: approved less claimed. The procurement list is derived
 *  from exactly that difference, so it is what a returned claim has to move. */
const pending = async (id: string, line: number) => {
  const p = (await prqs()).find((x: { id: string }) => x.id === id);
  const l = p.lines[line];
  return round3(l.appr - l.ordered);
};
/** The shelf as the server serves it. */
const onHand = async (loc: string, it: string) =>
  (await app.inject({ method: "GET", url: "/api/v1/stock", headers: await authHeaders(app, "u5") })).json().stock[loc]?.[it] ?? 0;
/** Quarantine's shelf, read off the balance row itself. `GET /stock` reports the five operating
 *  locations; the `StockLoc` widening that puts quarantine on it lands with the procurement
 *  reads. The row the ledger wrote is the same row either way. */
const quarantined = async (it: string) => {
  const [row] = await app.testDb!.db.select().from(stockBalances)
    .where(and(eq(stockBalances.loc, "quarantine"), eq(stockBalances.itemKey, it)));
  return row?.onHand ?? 0;
};
const moveCount = async () => (await app.testDb!.db.select().from(stockMoves)).length;

/** An order ready to receive against, with a live requisition claim behind it. */
const ordered = async (lines: { it: string; qty: number; recv?: number }[], st: "Ordered" | "Partially received" = "Ordered") => {
  const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: lines.map((l) => ({ it: l.it, qty: l.qty, appr: l.qty, ordered: l.qty })) });
  const id = await given.po(app.testDb!.db, { st, lines: lines.map((l, i) => ({ ...l, src: [{ prq, line: i, qty: l.qty }] })) });
  return { prq, id };
};
const doc = { dc: "DC-88214", invoice: "INV/AAV/4472", invDate: "2026-09-04" };
const good = (recv: number, over: Partial<{ rejected: number; batch: string; mrp: number; mfg: string; exp: string }> = {}) => ({
  recv, rejected: 0, batch: "AAV-8893", mrp: 0, mfg: "2026-09-01", exp: "2027-09-01", ...over,
});

describe("POST /purchase-orders/:id/receive", () => {
  it("books accepted stock straight onto the central store's shelf, one GRN per line", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }, { it: "butter", qty: 6 }]);
    const before = { milk: await onHand("store", "milk"), butter: await onHand("store", "butter") };

    const r = await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(80), good(6)] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.po.st).toBe("Received");
    expect(b.result.po.lines.map((l: { recv: number }) => l.recv)).toEqual([80, 6]);
    expect(b.result.grns).toHaveLength(2);
    expect(b.result.grns[0].id).toBe(`GRN-${id.slice(-3)}-01`);
    expect(b.result.grns[1].id).toBe(`GRN-${id.slice(-3)}-02`);
    expect(b.result.grns[0]).toMatchObject({ po: id, it: "milk", qty: 80, rejected: 0, batch: "AAV-8893", dc: "DC-88214", by: "Suresh Muthu" });
    expect(b.changed).toEqual(["po", "grn", "stock"]);
    expect(b.message).toBe("Booked into Central Store — 2 batch(es) against DC-88214");

    expect(await onHand("store", "milk")).toBeCloseTo(before.milk + 80, 3);
    expect(await onHand("store", "butter")).toBeCloseTo(before.butter + 6, 3);
    const mine = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refType, "grn"));
    expect(mine.filter((m) => m.kind === "grn_accept" && m.loc === "store")).toHaveLength(2);
  });

  it("puts what quality control turned away into quarantine, and nothing else", async () => {
    const { id } = await ordered([{ it: "water", qty: 120 }]);
    const store0 = await onHand("store", "water");
    const q0 = await quarantined("water");

    const b = (await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(120, { rejected: 12, mrp: 20 })] })).json();
    expect(b.result.grns[0]).toMatchObject({ qty: 108, rejected: 12 });
    expect(b.result.po.lines[0]).toMatchObject({ recv: 120, rejected: 12 });
    expect(b.message).toBe("Booked into Central Store — 108 nos accepted, 12 nos rejected");

    expect(await onHand("store", "water")).toBeCloseTo(store0 + 108, 3);
    expect(await quarantined("water")).toBeCloseTo(q0 + 12, 3);
    const mine = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, b.result.grns[0].id));
    expect(mine.map((m) => [m.kind, m.loc, m.qty])).toEqual([["grn_accept", "store", 108], ["grn_reject", "quarantine", 12]]);
  });

  it("proves the balance cache against the ledger after a receipt with rejects", async () => {
    const { id } = await ordered([{ it: "water", qty: 120 }]);
    await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(120, { rejected: 12, mrp: 20 })] });
    const before = await app.testDb!.db.select().from(stockBalances);
    await rebuildBalances(app.testDb!.db);
    const after = await app.testDb!.db.select().from(stockBalances);
    const cells = (rows: typeof before) => rows.map((r) => `${r.loc}:${r.itemKey}=${r.onHand}`).sort();
    expect(cells(after)).toEqual(cells(before));
  });

  it("leaves no phantom quarantine line on a clean delivery", async () => {
    // lockBalances creates the row it locks, and a zero row reads as "this location carries the
    // line" on every stock screen (M12). A clean delivery must post no reject move at all.
    const { id } = await ordered([{ it: "bisc", qty: 40 }]);
    await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(40)] });
    expect(await app.testDb!.db.select().from(stockBalances)
      .where(and(eq(stockBalances.loc, "quarantine"), eq(stockBalances.itemKey, "bisc")))).toHaveLength(0);
  });

  it("accumulates instalments, stays partially received in between, and numbers the GRNs on", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }]);
    const first = (await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(60)] })).json();
    expect(first.result.po.st).toBe("Partially received");
    expect(first.result.grns[0].id).toBe(`GRN-${id.slice(-3)}-01`);

    const second = (await post("u3", `/purchase-orders/${id}/receive`, { ...doc, dc: "DC-88999", lines: [good(20)] })).json();
    expect(second.result.po.st).toBe("Received");
    expect(second.result.po.lines[0].recv).toBe(80);
    expect(second.result.grns[0].id).toBe(`GRN-${id.slice(-3)}-02`);
  });

  it("takes an over-delivery inside 2% and refuses one beyond it, writing nothing", async () => {
    const { id } = await ordered([{ it: "juice", qty: 120 }]);
    const count = await moveCount();
    const r = await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(123, { mrp: 20 })] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Real Juice 200ml — 123 exceeds the ordered 120 by more than 2%; hold it for purchase approval");
    expect(await moveCount()).toBe(count);
    expect(await app.testDb!.db.select().from(grns).where(eq(grns.poId, id))).toHaveLength(0);

    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(122, { mrp: 20 })] })).statusCode).toBe(200);
  });

  it("counts what earlier instalments already booked in when it measures the tolerance", async () => {
    const { id } = await ordered([{ it: "juice", qty: 120 }]);
    await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(100, { mrp: 20 })] });
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(23, { mrp: 20 })] })).json().error.message)
      .toBe("Real Juice 200ml — 123 exceeds the ordered 120 by more than 2%; hold it for purchase approval");
  });

  it("refuses a line without a batch, without dates, with them the wrong way round, or already expired", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }]);
    const say = async (over: Record<string, unknown>) => (await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(10, over)] })).json().error.message;
    expect(await say({ batch: "  " })).toBe("Milk 1L (toned) needs its batch or lot number");
    expect(await say({ exp: "" })).toBe("Milk 1L (toned) needs a manufacturing and an expiry date");
    expect(await say({ mfg: "2027-01-01", exp: "2026-12-01" })).toBe("Milk 1L (toned) — expiry cannot fall on or before the manufacturing date");
    // Both dates are the hospital's, not the host's: vitest runs at TZ=UTC and IST is 5½ hours
    // ahead of it, so a "today" taken off toISOString() is yesterday to the server for the last
    // five and a half hours of every UTC day — and the same-day case below would fail there.
    const yesterday = istDate(new Date(Date.now() - 86400_000));
    expect(await say({ mfg: "2020-01-01", exp: yesterday })).toBe(`Milk 1L (toned) — batch AAV-8893 has already expired; do not book it in`);
    // and a batch expiring today is still fit to sell
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(10, { mfg: "2020-01-01", exp: istDate(new Date()) })] })).statusCode).toBe(200);
  });

  it("refuses a printed MRP below the shelf price, and a rejection larger than the delivery", async () => {
    const { id } = await ordered([{ it: "juice", qty: 120 }]);
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(120, { mrp: 15 })] })).json().error.message)
      .toBe("Real Juice 200ml — printed MRP ₹15.00 is below the shelf price; reprice before selling");
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(120, { mrp: 20, rejected: 130 })] })).json().error.message)
      .toBe("Real Juice 200ml — rejected quantity cannot exceed what arrived");
  });

  it("refuses a receipt with no delivery note, with nothing on it, or against a closed order", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }]);
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, dc: "  ", lines: [good(10)] })).json().error.message)
      .toBe("Record the vendor's delivery note number before booking goods in");
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(0)] })).json().error.message)
      .toBe("Enter what arrived on at least one line");
    expect((await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(10), good(10)] })).json().error.message)
      .toBe("Give a line for each of the 1 lines on this order");
    const draft = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 80 }] });
    expect((await post("u3", `/purchase-orders/${draft}/receive`, { ...doc, lines: [good(10)] })).json().error.message)
      .toBe(`${draft} is draft — nothing can be booked against it`);
  });

  it("is open to the buyer as well as the store keeper, and to nobody else", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }]);
    expect((await post("u5", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(10)] })).statusCode).toBe(200);
    for (const u of ["u1", "u2", "u4"]) {
      expect((await post(u, `/purchase-orders/${id}/receive`, { ...doc, lines: [good(10)] })).statusCode).toBe(404);
    }
    expect((await post("u3", "/purchase-orders/PO-2026-9999/receive", { ...doc, lines: [good(1)] })).json().error.message)
      .toBe("There is no purchase order PO-2026-9999.");
  });

  it("books one delivery, not two, when the door and the desk press together", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }]);
    const before = await onHand("store", "milk");
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(80)] }),
      post("u5", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(80)] }),
    ]);
    // The second sees 80 already received and 160 over the 2% tolerance.
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    expect(await onHand("store", "milk")).toBeCloseTo(before + 80, 3);
    expect(await app.testDb!.db.select().from(grns).where(eq(grns.poId, id))).toHaveLength(1);
  });
});

describe("POST /purchase-orders/:id/close-short", () => {
  it("returns the undelivered balance to the list and closes the order as received", async () => {
    const { prq, id } = await ordered([{ it: "milk", qty: 80 }]);
    await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(60)] });
    expect(await pending(prq, 0)).toBe(0);

    const b = (await post("u5", `/purchase-orders/${id}/close-short`, { reason: "Vendor cannot deliver the balance" })).json();
    expect(b.result).toMatchObject({ st: "Received", shortNote: "Vendor cannot deliver the balance" });
    expect(b.result.hist.at(-1)).toMatchObject({ s: "Closed short", who: "Latha Narayanan" });
    expect(b.changed).toEqual(["po", "prq"]);
    expect(b.message).toBe(`${id} closed short — the undelivered balance is back on the procurement list`);
    expect(await pending(prq, 0)).toBe(20);
  });

  it("splits a shortfall across several source requisitions, releasing the last one first", async () => {
    const a = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 25, appr: 25, ordered: 25 }] });
    const c = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80, ordered: 80 }] });
    const id = await given.po(app.testDb!.db, { st: "Partially received", lines: [
      { it: "milk", qty: 105, recv: 60, src: [{ prq: a, line: 0, qty: 25 }, { prq: c, line: 0, qty: 80 }] },
    ] });
    await post("u5", `/purchase-orders/${id}/close-short`, { reason: "Balance not coming" });
    expect(await pending(c, 0)).toBe(45);
    expect(await pending(a, 0)).toBe(0);
  });

  it("wants a reason, refuses an order that is not partly received, and will not run twice", async () => {
    const { id } = await ordered([{ it: "milk", qty: 80 }], "Partially received");
    expect((await post("u5", `/purchase-orders/${id}/close-short`, { reason: "  " })).json().error.message)
      .toBe("Give a reason for closing this order short");
    const draft = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 80 }] });
    expect((await post("u5", `/purchase-orders/${draft}/close-short`, { reason: "x" })).json().error.message)
      .toBe(`${draft} is draft — only a partly received order can be closed short`);
    await post("u5", `/purchase-orders/${id}/close-short`, { reason: "x" });
    expect((await post("u5", `/purchase-orders/${id}/close-short`, { reason: "x" })).json().error.message)
      .toBe(`${id} is received — only a partly received order can be closed short`);
  });

  it("gives the balance back exactly once when two screens close together", async () => {
    const { prq, id } = await ordered([{ it: "milk", qty: 80 }]);
    await post("u3", `/purchase-orders/${id}/receive`, { ...doc, lines: [good(60)] });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u5", `/purchase-orders/${id}/close-short`, { reason: "a" }),
      post("u5", `/purchase-orders/${id}/close-short`, { reason: "b" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await pending(prq, 0)).toBe(20);       // 20, not 40
  });
});
