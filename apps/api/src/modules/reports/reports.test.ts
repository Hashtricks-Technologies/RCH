import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import * as FX from "@rch/contract/fixtures";
import type { CreditResponse, StockLedgerResponse } from "@rch/contract";
import { round3, STAFF_CREDIT_LIMIT } from "@rch/domain";
import type { App } from "../../app.js";
import { buildTestApp } from "../../test/app.js";
import { truncateAll } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { monthStartIST } from "../../lib/time.js";
import * as s from "../../db/schema/index.js";
import { reportsRepo } from "./repo.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "reports" }); await app.ready(); });
// `buildTestApp` migrates but does NOT seed, and `authHeaders` throws
// `no user u1 - did you seed?` without this.
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });
afterAll(async () => { await app.close(); });

const round2 = (v: number) => Math.round(v * 100) / 100;
/** Pick payers out of the fixtures, never by naming a number — the seed moves. `kind` is
 *  re-stated as a literal because the fixture lists are typed `Payer[]`, whose `kind` is the
 *  whole union; every row of `FX.STAFF` carries "staff" and the sale's payer takes only that. */
const STAFF = { ...FX.STAFF[0], kind: "staff" as const };
const DEPT = FX.DEPTS[0];

const ledger = async (loc: string, days = 30): Promise<StockLedgerResponse> => {
  const res = await app.inject({ method: "GET", url: `/api/v1/reports/stock-ledger?loc=${loc}&days=${days}`, headers: await authHeaders(app, "u3") });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as StockLedgerResponse;
};
const total = (b: StockLedgerResponse, col: "opening" | "recd" | "issued" | "closing") =>
  round3(b.rows.reduce((t, r) => t + r[col], 0));

const credit = async (p: { kind: "patient" | "staff" | "dept"; id: string }): Promise<CreditResponse> => {
  const res = await app.inject({ method: "GET", url: `/api/v1/reports/credit/${p.kind}/${p.id}`, headers: await authHeaders(app, "u1") });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as CreditResponse;
};

/**
 * Put this person within `room` rupees of the ceiling with bills that are already taken, then
 * sell them one more thing at the till and hand back the refusal.
 *
 * The brief's first draft did this by selling 80 bottles of water five times over. It cannot:
 * the coffee shop's shelf holds twelve, so the sale is refused by the cover check with a
 * different sentence and no `details` on it, and the case would be pinning the wrong refusal.
 * A builder-made bill moves no stock, which is exactly what is wanted here — the ceiling is
 * about money already spent, not about the shelf.
 */
const sellPastTheCeiling = async (payer: { kind: "staff"; id: string; name: string }, room = 10) => {
  const taken = (await credit(payer)).taken;
  await given.bill(app.db, { loc: "coffee", tender: "Staff credit", payer, total: round2(STAFF_CREDIT_LIMIT - taken - room), lines: [{ it: "water", qty: 1, rate: 20 }] });
  // One bottle of mineral water at the Coffee Shop is ₹20 on price list B — more than the room
  // left, and one unit of a shelf that holds twelve, so nothing but the ceiling can refuse it.
  const res = await app.inject({
    method: "POST", url: "/api/v1/bills",
    headers: { ...(await authHeaders(app, "u1")), "idempotency-key": randomUUID() },
    payload: { loc: "coffee", tender: "Staff credit", payer, lines: [{ it: "water", qty: 1 }] },
  });
  expect(res.statusCode, res.body).toBe(422);
  // The counter's own wording (`creditBreachMessage` in @rch/domain), repeated word for word.
  expect((res.json() as { error: { message: string } }).error.message).toContain("staff credit limit");
  return res;
};

describe("GET /reports/stock-ledger", () => {
  it("opens at what the moves before the window sum to and closes at the balance", async () => {
    // Pick the item by filtering rather than naming one: the seed moves.
    const [{ itemKey: it }] = await app.db.select({ itemKey: s.stockBalances.itemKey }).from(s.stockBalances)
      .where(and(eq(s.stockBalances.loc, "store"), gt(s.stockBalances.onHand, 0))).limit(1);

    const body = await ledger("store", 30);
    const row = body.rows.find((r) => r.it === it)!;

    // Spec §12: "db:rebuild-balances reproduces stock_balances exactly from stock_moves." The
    // report is the same sum by another route, so its closing column has to agree with the cache
    // — and that is the whole reason this report is a server query and not browser arithmetic.
    const [bal] = await app.db.select().from(s.stockBalances).where(and(eq(s.stockBalances.loc, "store"), eq(s.stockBalances.itemKey, it)));
    expect(row.closing).toBe(Number(bal.onHand));
    // The seed's own numbers, not the formula that produced them — `ledgerRow` in @rch/domain
    // defines `closing` as exactly this sum, so recomputing it here would prove nothing.
    expect(row.opening).toBe(0);
    expect(row.recd).toBe(18.4);
    expect(row.issued).toBe(0);
    expect(row.closing).toBe(18.4);
    // The window it says it measured is the window it measured.
    expect(new Date(body.to).getTime() - new Date(body.from).getTime()).toBe(30 * 86_400_000);
    expect(body.loc).toBe("store");
  });

  it("splits on `at < from` and `at >= from`, so a move is on exactly one side of the edge", async () => {
    // The one boundary the SQL owns and that no domain test can catch (Task 2's report, concern
    // 3): `openingAt` takes `at < from` and `movedIn` takes `at >= from`. Rather than age a move
    // — which would mean writing `stock_moves` from a test — take a real receipt's own instant
    // and walk the window's edge across it by one millisecond. The receipt has to be inside the
    // window when `from` is its own instant, and in the opening balance one millisecond later:
    // exactly five units move from one column to the other, and none is counted twice or lost.
    const { id } = await orderedFor([{ it: "sugar", qty: 5 }]);
    expect((await receive("u3", id, [line(5)])).statusCode).toBe(200);
    const [m] = await app.db.select().from(s.stockMoves)
      .where(and(eq(s.stockMoves.loc, "store"), eq(s.stockMoves.itemKey, "sugar"), eq(s.stockMoves.kind, "grn_accept")));
    const at = m.at;
    const justAfter = new Date(at.getTime() + 1);
    const to = new Date(at.getTime() + 60_000);

    const [onEdge, pastEdge] = await Promise.all([
      reportsRepo.movedIn(app.db, "store", at, to),
      reportsRepo.movedIn(app.db, "store", justAfter, to),
    ]);
    const [openOnEdge, openPastEdge] = await Promise.all([
      reportsRepo.openingAt(app.db, "store", at),
      reportsRepo.openingAt(app.db, "store", justAfter),
    ]);
    expect(round3((onEdge.get("sugar")?.recd ?? 0) - (pastEdge.get("sugar")?.recd ?? 0))).toBe(5);
    expect(round3((openPastEdge.get("sugar") ?? 0) - (openOnEdge.get("sugar") ?? 0))).toBe(5);

    // And the two halves still add up to the shelf, whichever side the edge falls on.
    const [bal] = await app.db.select().from(s.stockBalances)
      .where(and(eq(s.stockBalances.loc, "store"), eq(s.stockBalances.itemKey, "sugar")));
    const w = onEdge.get("sugar") ?? { recd: 0, issued: 0 };
    expect(round3((openOnEdge.get("sugar") ?? 0) + w.recd - w.issued)).toBe(Number(bal.onHand));
  });

  it("puts a receipt's rejected quantity on quarantine's ledger and not on the store's", async () => {
    const before = { q: await ledger("quarantine"), store: await ledger("store") };
    const { id } = await orderedFor([{ it: "milk", qty: 40 }]);
    // Forty litres arrive, three of them are turned away: 37 onto the store's shelf, 3 onto
    // quarantine's — the only view anyone has of what a goods receipt refused.
    const res = await receive("u3", id, [line(40, { rejected: 3 })]);
    expect(res.statusCode, res.body).toBe(200);

    const after = { q: await ledger("quarantine"), store: await ledger("store") };
    expect(round3(total(after.q, "recd") - total(before.q, "recd"))).toBe(3);
    expect(round3(total(after.store, "recd") - total(before.store, "recd"))).toBe(37);
    // And nothing was issued anywhere to make either number: a receipt only ever adds.
    expect(total(after.q, "issued")).toBe(total(before.q, "issued"));
  });

  it("counts a window, not everything", async () => {
    // Every seeded move is stamped `now()`, so a 365-day window and a 1-day window sum the same
    // rows and this case cannot fail on the totals alone — what `days` actually changes is the
    // window itself: a wider window opens earlier, and each window's own width is `days` long.
    const wide = await ledger("store", 365);
    const narrow = await ledger("store", 1);
    expect(new Date(wide.from).getTime()).toBeLessThan(new Date(narrow.from).getTime());
    expect(new Date(wide.to).getTime() - new Date(wide.from).getTime()).toBe(365 * 86_400_000);
    expect(new Date(narrow.to).getTime() - new Date(narrow.from).getTime()).toBe(1 * 86_400_000);
    // Both windows close on the same "now" — the two requests land a few milliseconds apart,
    // not on different days.
    expect(Math.abs(new Date(wide.to).getTime() - new Date(narrow.to).getTime())).toBeLessThan(5000);
  });

  it("lists a shelf the window never touched — a zero row means the location carries the line", async () => {
    const body = await ledger("store", 1);
    const carried = await app.db.select().from(s.stockBalances).where(eq(s.stockBalances.loc, "store"));
    for (const b of carried) expect(body.rows.map((r) => r.it)).toContain(b.itemKey);
  });

  it("is not a counter operator's report", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/reports/stock-ledger?loc=store", headers: await authHeaders(app, "u1") });
    expect(res.statusCode).toBe(404);
  });

  it("refuses a location that is not one", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/reports/stock-ledger?loc=canteen", headers: await authHeaders(app, "u3") });
    expect(res.statusCode).toBe(400);
  });

  it("answers the store keeper, the manager, the buyer and the kitchen alike", async () => {
    for (const u of ["u2", "u3", "u4", "u5"]) {
      const res = await app.inject({ method: "GET", url: "/api/v1/reports/stock-ledger?loc=store", headers: await authHeaders(app, u) });
      expect(res.statusCode, `${u}: ${res.body}`).toBe(200);
    }
  });
});

describe("GET /reports/credit/:kind/:id", () => {
  it("answers with exactly the number the till refuses on", async () => {
    // `given.bill` takes the bill's `total` as well as its lines — it is what the credit sum
    // adds up, and the builder does not derive it.
    await given.bill(app.db, { loc: "coffee", tender: "Staff credit", payer: STAFF, total: 20, lines: [{ it: "water", qty: 1, rate: 20 }] });
    const body = await credit(STAFF);
    expect(body.taken).toBe(20);
    // ₹3,000 limit less ₹20 taken — the seed's own number, not `creditRoom` re-run on it.
    expect(body.room).toBe(2980);
    expect(body.limit).toBe(STAFF_CREDIT_LIMIT);
    expect(body.name).toBe(STAFF.name);

    // The other half of the same fact: sell past the ceiling, and the refusal's own
    // `details.taken` must equal what the report says immediately afterwards.
    const refusal = await sellPastTheCeiling(STAFF);
    const after = await credit(STAFF);
    expect((refusal.json() as { error: { details: { taken: number } } }).error.details.taken).toBe(after.taken);
    // `sellPastTheCeiling`'s default `room` of 10 — left exactly there by construction.
    expect(after.room).toBe(10);
  });

  it("counts the calendar month across every outlet, not one till's week", async () => {
    // A bill at the restaurant and a bill at the coffee shop both count against one person.
    await given.bill(app.db, { loc: "rest", tender: "Staff credit", payer: STAFF, total: 20, lines: [{ it: "water", qty: 1, rate: 20 }] });
    const a = (await credit(STAFF)).taken;
    await given.bill(app.db, { loc: "coffee", tender: "Staff credit", payer: STAFF, total: 20, lines: [{ it: "water", qty: 1, rate: 20 }] });
    expect((await credit(STAFF)).taken).toBe(round2(a + 20));
    // `since` is midnight on the 1st in IST, i.e. 18:30 UTC on the last day of the previous month.
    const since = new Date((await credit(STAFF)).since);
    expect(since.toISOString()).toBe(monthStartIST().toISOString());
  });

  it("leaves last month's credit behind", async () => {
    const before = (await credit(STAFF)).taken;
    const lastMonth = new Date(monthStartIST().getTime() - 86_400_000);
    await given.bill(app.db, { loc: "coffee", tender: "Staff credit", payer: STAFF, total: 500, at: lastMonth, lines: [{ it: "water", qty: 1, rate: 20 }] });
    expect((await credit(STAFF)).taken).toBe(before);
  });

  it("counts only what the credit tender created", async () => {
    const before = (await credit(STAFF)).taken;
    await given.bill(app.db, { loc: "coffee", tender: "Cash", payer: STAFF, total: 20, lines: [{ it: "water", qty: 1, rate: 20 }] });
    expect((await credit(STAFF)).taken).toBe(before);
  });

  it("answers zero for a payer whose tender never creates credit", async () => {
    const body = await credit({ kind: "dept", id: DEPT.id });
    // Only the "Staff credit" tender runs up a balance, and it carries a staff payer. A
    // department's report is structurally zero — the row exists so a screen can say so.
    expect(body.taken).toBe(0);
    expect(body.room).toBe(body.limit);
    expect(body.name).toBe(DEPT.name);
  });

  it("is a 404 for a payer who is not on the roster", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/reports/credit/staff/RC-0000", headers: await authHeaders(app, "u1") });
    expect(res.statusCode).toBe(404);
  });

  it("is the manager's report too, and nobody else's", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/v1/reports/credit/staff/${STAFF.id}`, headers: await authHeaders(app, "u2") });
    expect(ok.statusCode, ok.body).toBe(200);
    for (const u of ["u3", "u4", "u5"]) {
      const res = await app.inject({ method: "GET", url: `/api/v1/reports/credit/staff/${STAFF.id}`, headers: await authHeaders(app, u) });
      expect(res.statusCode, `${u}: ${res.body}`).toBe(404);
    }
  });
});

/** An order ready to receive against, with a live requisition claim behind it — the shape
 *  `grn.test.ts` uses. A rejection is the only way stock reaches quarantine, so it is the only
 *  way to prove the ledger reports a `StockLoc` and not merely a `LocKey`. */
const orderedFor = async (lines: { it: string; qty: number }[]) => {
  const prq = await given.requisition(app.db, { st: "Approved", lines: lines.map((l) => ({ it: l.it, qty: l.qty, appr: l.qty, ordered: l.qty })) });
  const id = await given.po(app.db, { st: "Ordered", lines: lines.map((l, i) => ({ ...l, src: [{ prq, line: i, qty: l.qty }] })) });
  return { prq, id };
};
const line = (recv: number, over: Partial<{ rejected: number }> = {}) =>
  ({ recv, rejected: 0, batch: "AAV-8893", mrp: 0, mfg: "2026-09-01", exp: "2027-09-01", ...over });
const receive = async (user: string, id: string, lines: Record<string, unknown>[]) =>
  app.inject({
    method: "POST", url: `/api/v1/purchase-orders/${id}/receive`,
    headers: { ...(await authHeaders(app, user)), "idempotency-key": randomUUID() },
    payload: { dc: "DC-88214", invoice: "INV/AAV/4472", invDate: "2026-09-04", lines },
  });
