import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { BillSchema, StockResponseSchema } from "@rch/contract";
import * as s from "../../db/schema/index.js";
import { postMoves, rebuildBalances } from "../../lib/ledger.js";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "pos" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

type PayLine = { it: string; qty: number };
type PayBody = { loc: string; tender: string; payer?: { kind: string; id: string; name: string }; lines: PayLine[] };

const pay = async (userId: string, body: PayBody, key: string = randomUUID()) =>
  app.inject({ method: "POST", url: "/api/v1/bills", headers: { ...(await authHeaders(app, userId)), "idempotency-key": key }, payload: body });

const onHand = async (loc: string, it: string): Promise<number> => {
  const [row] = await app.db.select().from(s.stockBalances).where(and(eq(s.stockBalances.loc, loc), eq(s.stockBalances.itemKey, it)));
  return row?.onHand ?? 0;
};
const stockOf = async (userId: string) => {
  const r = await app.inject({ method: "GET", url: "/api/v1/stock", headers: await authHeaders(app, userId) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { stock: Record<string, Record<string, number>>; rsv: Record<string, number>; ovr: Record<string, string> };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("POST /bills — the counter sale", () => {
  it("prices the cart, numbers the bill and answers with the record", async () => {
    const before = await stockOf("u1");
    const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 2 }, { it: "chips", qty: 2 }, { it: "bisc", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(BillSchema.safeParse(b.result).success, JSON.stringify(b.result)).toBe(true);
    expect(b.result.no).toBe("CF/1188");
    expect(b.result.loc).toBe("coffee");
    expect(b.result.tot).toBe(110);          // list B at the Coffee Shop: juice 20, chips 20, bisc 30
    expect(b.result.tax).toBe(13.15);        // 12% on the beverages, 18% on the biscuit, inclusive
    expect(b.result.pay).toBe("Cash");
    expect(b.result.opr).toBe("Kavitha Raman");
    expect(b.result.oprCol).toBe("#B45309");
    expect(b.result.payer).toBeUndefined();
    expect(b.result.lines).toEqual([{ it: "juice", qty: 2, rate: 20 }, { it: "chips", qty: 2, rate: 20 }, { it: "bisc", qty: 1, rate: 30 }]);
    expect(new Date(b.result.t).toISOString()).toBe(b.result.t);
    expect(b.changed).toEqual(["stock", "bills"]);
    expect(b.message).toBe("Bill CF/1188 · ₹110.00 collected at Coffee Shop");

    const after = await stockOf("u1");
    expect(StockResponseSchema.safeParse(after).success).toBe(true);
    expect(after.stock.coffee.juice).toBe(before.stock.coffee.juice - 2);
    expect(after.stock.coffee.chips).toBe(before.stock.coffee.chips - 2);
    expect(after.stock.coffee.bisc).toBe(before.stock.coffee.bisc - 1);
  });

  it("wrote the bill, its lines and its moves — and no history, because a bill has none", async () => {
    const [head] = await app.db.select().from(s.bills).where(eq(s.bills.no, "CF/1188"));
    expect(head).toBeTruthy();
    expect(head.loc).toBe("coffee");
    expect(head.operatorId).toBe("u1");
    expect(head.total).toBe(110);
    expect(head.tax).toBe(13.15);
    expect(head.tender).toBe("Cash");
    expect(head.payerKind).toBeNull();

    const lines = await app.db.select().from(s.billLines).where(eq(s.billLines.billNo, "CF/1188")).orderBy(asc(s.billLines.lineNo));
    expect(lines.map((l) => [l.itemKey, l.qty, l.rate])).toEqual([["juice", 2, 20], ["chips", 2, 20], ["bisc", 1, 30]]);

    const moves = await app.db.select().from(s.stockMoves).where(and(eq(s.stockMoves.refType, "bill"), eq(s.stockMoves.refId, "CF/1188")));
    expect(moves.map((m) => [m.itemKey, m.qty]).sort()).toEqual([["bisc", -1], ["chips", -2], ["juice", -2]].sort());
    expect(moves.every((m) => m.kind === "sale" && m.loc === "coffee" && m.byUser === "u1")).toBe(true);

    const hist = await app.db.select().from(s.documentHistory).where(eq(s.documentHistory.docId, "CF/1188"));
    expect(hist).toEqual([]);
  });

  it("folds a repeated item into one line", async () => {
    const r = await pay("u1", { loc: "coffee", tender: "Card", lines: [{ it: "water", qty: 1 }, { it: "water", qty: 2 }] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.lines).toEqual([{ it: "water", qty: 3, rate: 20 }]);
    expect(b.result.tot).toBe(60);
    expect(b.message).toBe(`Bill ${b.result.no} · ₹60.00 settled by card at Coffee Shop`);
  });

  it("names the payer on a credit tender", async () => {
    const r = await pay("u1", { loc: "coffee", tender: "Patient bill", payer: { kind: "patient", id: "IP-4471", name: "Anitha, Room 312" }, lines: [{ it: "juice", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.payer).toEqual({ kind: "patient", id: "IP-4471", name: "Anitha, Room 312" });
    expect(b.message).toBe(`Bill ${b.result.no} · ₹20.00 posted to Anitha, Room 312`);
  });
});

describe("the rules refuse before anything is written", () => {
  const rejects = async (body: PayBody, message: string) => {
    const before = await app.db.select().from(s.bills);
    const r = await pay("u1", body);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toMatchObject({ code: "rule", message });
    expect((await app.db.select().from(s.bills)).length).toBe(before.length);
  };

  it("wants a patient before it takes a patient bill", async () => {
    await rejects({ loc: "coffee", tender: "Patient bill", lines: [{ it: "juice", qty: 1 }] }, "Choose a patient before taking a patient bill");
  });
  it("wants a staff member before it takes a staff credit", async () => {
    await rejects({ loc: "coffee", tender: "Staff credit", lines: [{ it: "juice", qty: 1 }] }, "Choose a staff member before taking a staff credit");
  });
  it("wants a department before it takes a dept bill", async () => {
    await rejects({ loc: "coffee", tender: "Dept", lines: [{ it: "juice", qty: 1 }] }, "Choose a department before taking a dept");
  });
  it("refuses an item the counter does not list", async () => {
    await rejects({ loc: "coffee", tender: "Cash", lines: [{ it: "puff", qty: 1 }] }, "Veg puffs is not listed at Coffee Shop");
  });
  it("answers 404 for an item the master has never heard of", async () => {
    const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "nosuch", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json().error.message).toBe("There is no item nosuch.");
  });
  it("refuses a made-to-order item whose ingredient has run out, and names it", async () => {
    await rejects({ loc: "coffee", tender: "Cash", lines: [{ it: "capp", qty: 1 }] }, "Cappuccino is not available at Coffee Shop — Milk 1L (toned) at 0.000 L");
  });
  it("refuses more of a traded item than the shelf holds", async () => {
    await rejects({ loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 99 }] }, "Only 9 nos of Mineral water 1L left at Coffee Shop");
  });
});

describe("a made-to-order sale is a recipe, posted", () => {
  // The Coffee Shop's milk is at zero in the seed — a delivery has to land before a cappuccino can be sold.
  beforeAll(async () => {
    await app.db.transaction(async (tx) => {
      await postMoves(tx, [{ loc: "coffee", it: "milk", qty: 5, kind: "opening", refType: "test", refId: "milk-delivery" }]);
    });
  });

  it("counts portions, not units, when the cart asks for too many", async () => {
    const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "capp", qty: 100 }] });
    expect(r.statusCode, r.body).toBe(422);
    // 5 L of milk at 0.15 L a cup is 33 cappuccinos; the other three ingredients go further.
    expect(r.json().error.message).toBe("Only 33 nos of Cappuccino left at Coffee Shop");
  });

  it("explodes one cappuccino into four negative sale moves", async () => {
    const milk = await onHand("coffee", "milk");
    const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "capp", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.tot).toBe(75);
    expect(b.result.tax).toBe(3.57);
    expect(b.result.lines).toEqual([{ it: "capp", qty: 1, rate: 75 }]);

    const moves = await app.db.select().from(s.stockMoves).where(and(eq(s.stockMoves.refType, "bill"), eq(s.stockMoves.refId, b.result.no)));
    expect(Object.fromEntries(moves.map((m) => [m.itemKey, m.qty]))).toEqual({ milk: -0.15, beans: -0.012, sugar: -0.006, cup: -1 });
    expect(moves.every((m) => m.kind === "sale" && m.qty < 0 && m.refId === b.result.no)).toBe(true);
    // The finished drink is never stocked: only the ingredients move.
    expect(moves.some((m) => m.itemKey === "capp")).toBe(false);
    expect(await onHand("coffee", "milk")).toBe(milk - 0.15);
  });
});

describe("who may bill", () => {
  it("refuses a counter operator billing somebody else's counter", async () => {
    const r = await pay("u1", { loc: "kiosk", tender: "Cash", lines: [{ it: "juice", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error.message).toBe("You can only do this for your own counter.");
  });
  it("hides the route from a manager altogether", async () => {
    const r = await pay("u2", { loc: "rest", tender: "Cash", lines: [{ it: "juice", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(404);
  });
  it("lets the other counter sell at their own shop", async () => {
    const r = await pay("u6", { loc: "kiosk", tender: "Cash", lines: [{ it: "juice", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.loc).toBe("kiosk");
    expect(r.json().result.lines[0].rate).toBe(18); // the kiosk is on list A
  });
});

describe("a bill is written once", () => {
  it("insists on an Idempotency-Key", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/bills", headers: await authHeaders(app, "u1"), payload: { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }] } });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe("validation");
  });

  it("replays the first answer instead of billing twice", async () => {
    const key = randomUUID();
    const body: PayBody = { loc: "coffee", tender: "Cash", lines: [{ it: "chips", qty: 1 }] };
    const first = await pay("u1", body, key);
    expect(first.statusCode, first.body).toBe(200);
    const chipsAfterFirst = await onHand("coffee", "chips");

    const again = await pay("u1", body, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.json()).toEqual(first.json());
    expect(await onHand("coffee", "chips")).toBe(chipsAfterFirst);
    expect((await app.db.select().from(s.bills).where(eq(s.bills.no, first.json().result.no))).length).toBe(1);
  });
});

describe("the ledger, not the pre-check, is the guarantee", () => {
  it("refuses a sale that the lock reveals is already gone", async () => {
    // The pre-check reads before it locks, so a sale can pass it on a stale number. Hold the
    // biscuit's balance row, let a bill read past it, then empty the shelf underneath: the sale
    // must fail on the post-lock check and leave nothing behind.
    const have = await onHand("coffee", "bisc");
    expect(have).toBeGreaterThan(0);
    const billsBefore = (await app.db.select().from(s.bills)).length;

    const drained = app.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from stock_balances where loc = 'coffee' and item_key = 'bisc' for update`); // hold the row
      await sleep(400);                                                                                          // the sale reads, then blocks on it
      await postMoves(tx, [{ loc: "coffee", it: "bisc", qty: -have, kind: "adjustment", refType: "test", refId: "drain" }]);
    });
    await sleep(50);
    const t0 = Date.now();
    const sale = pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "bisc", qty: have }] });
    const [r] = await Promise.all([sale, drained]);

    // It could only have taken that long by waiting on the lock, which is past the pre-check:
    // the refusal below is the post-lock read talking, not the friendly one.
    expect(Date.now() - t0).toBeGreaterThan(250);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toMatchObject({ code: "rule", message: "Only 0 nos of Marie biscuit 120g left at Coffee Shop" });
    expect(await onHand("coffee", "bisc")).toBe(0);
    expect((await app.db.select().from(s.bills)).length).toBe(billsBefore);
  });

  it("lets exactly one of two tills sell the last units", async () => {
    await app.db.transaction(async (tx) => {
      await postMoves(tx, [{ loc: "coffee", it: "bisc", qty: 6, kind: "opening", refType: "test", refId: "bisc-delivery" }]);
    });
    const body: PayBody = { loc: "coffee", tender: "Cash", lines: [{ it: "bisc", qty: 6 }] };
    const [a, b] = await Promise.all([pay("u1", body), pay("u1", body)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes, `${a.body} | ${b.body}`).toEqual([200, 422]);
    const loser = a.statusCode === 422 ? a : b;
    expect(loser.json().error.code).toBe("rule");
    expect(loser.json().error.message).toContain("Marie biscuit 120g");
    expect(await onHand("coffee", "bisc")).toBe(0);
  });

  it("leaves the balance cache equal to the moves that made it", async () => {
    const cached = await app.db.select().from(s.stockBalances);
    const before = Object.fromEntries(cached.map((r) => [`${r.loc}:${r.itemKey}`, r.onHand]));
    await rebuildBalances(app.db);
    const rebuilt = Object.fromEntries((await app.db.select().from(s.stockBalances)).map((r) => [`${r.loc}:${r.itemKey}`, r.onHand]));
    // rebuild drops the zero-quantity rows the seed creates for a listed-but-empty item, so
    // compare only what the moves account for.
    for (const [k, v] of Object.entries(rebuilt)) expect(before[k], k).toBe(v);
    expect(Object.values(rebuilt).every((v) => v >= 0)).toBe(true);
  });
});
