import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { BillSchema, StockResponseSchema } from "@rch/contract";
import * as s from "../../db/schema/index.js";
import { lockBalances, postMoves, rebuildBalances } from "../../lib/ledger.js";
import { reserve } from "../../lib/reservations.js";
import { buildTestApp } from "../../test/app.js";
import { given } from "../../test/builders.js";
import { warmPool } from "../../test/db.js";
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

  it("names the payer on a credit tender — with the name the roster carries", async () => {
    const r = await pay("u1", { loc: "coffee", tender: "Patient bill", payer: { kind: "patient", id: "IP-4471", name: "Anitha, Room 312" }, lines: [{ it: "juice", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.payer).toEqual({ kind: "patient", id: "IP-4471", name: "Anand Kumar · Ward 3B" });
    expect(b.message).toBe(`Bill ${b.result.no} · ₹20.00 posted to Anand Kumar · Ward 3B`);
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
  it("refuses a staff credit posted to somebody who is not staff", async () => {
    // The tender and the payer have to agree, or the bill runs up a balance the ceiling never
    // measures: it counts staff payers, and this one would land on a patient's account.
    await rejects(
      { loc: "coffee", tender: "Staff credit", payer: { kind: "patient", id: "IP-4471", name: "Anitha, Room 312" }, lines: [{ it: "water", qty: 1 }] },
      "Choose a staff member for a staff credit — Anitha, Room 312 is not one");
  });
  it("refuses a patient bill posted to a staff member", async () => {
    await rejects(
      { loc: "coffee", tender: "Patient bill", payer: { kind: "staff", id: "RC-2088", name: "Suresh Muthu · Stores" }, lines: [{ it: "water", qty: 1 }] },
      "Choose a patient for a patient bill — Suresh Muthu · Stores is not one");
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
  it("refuses a tender that is not one of the six — 400 at the door, not a rule", async () => {
    // "staff credit" is not "Staff credit": a tender is a closed set on the wire, so a near
    // miss is a malformed request, never a bill settled under a name nothing else recognises.
    const r = await pay("u1", { loc: "coffee", tender: "staff credit", payer: { kind: "staff", id: "E-1", name: "Anitha" }, lines: [{ it: "juice", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe("validation");
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

describe("the printed MRP is the ceiling at the till too", () => {
  it("charges the MRP when the list has drifted above it", async () => {
    // `savePrice` refuses a price above the MRP, so the only way a list sits above one is an
    // MRP lowered after the item was priced. Write it straight into the table to make that
    // history, then sell one: the bill charges what is printed on the pack, not what the list says.
    const before = (await app.db.select().from(s.priceListItems).where(and(eq(s.priceListItems.list, "B"), eq(s.priceListItems.itemKey, "juice"))))[0];
    await app.db.update(s.priceListItems).set({ price: 25 })
      .where(and(eq(s.priceListItems.list, "B"), eq(s.priceListItems.itemKey, "juice")));
    try {
      const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }] });
      expect(r.statusCode, r.body).toBe(200);
      const b = r.json();
      expect(b.result.lines).toEqual([{ it: "juice", qty: 1, rate: 20 }]);   // MRP 20, list 25
      expect(b.result.tot).toBe(20);
      expect(b.message).toBe(`Bill ${b.result.no} · ₹20.00 collected at Coffee Shop`);
    } finally {
      await app.db.update(s.priceListItems).set({ price: before.price })
        .where(and(eq(s.priceListItems.list, "B"), eq(s.priceListItems.itemKey, "juice")));
    }
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
      await sleep(1000);                                                                                          // the sale reads, then blocks on it
      await postMoves(tx, [{ loc: "coffee", it: "bisc", qty: -have, kind: "adjustment", refType: "test", refId: "drain" }]);
    });
    await sleep(50);
    const t0 = Date.now();
    // The sale's own elapsed time, not the pair's: `drained` sleeps 400 ms by itself, so timing
    // the `Promise.all` would pass however fast the bill came back.
    const sale = pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "bisc", qty: have }] }).then((r) => ({ r, ms: Date.now() - t0 }));
    const [{ r, ms }] = await Promise.all([sale, drained]);

    // It could only have taken that long by waiting on the lock, which is past the pre-check:
    // the refusal below is the post-lock read talking, not the friendly one.
    expect(ms).toBeGreaterThan(250);
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
    // Every row, not just the ones the moves account for: the rebuild zeroes and re-adds rather
    // than deleting, so the seed's listed-but-empty rows are still there afterwards, at zero.
    expect(rebuilt).toEqual(before);
    expect(Object.values(rebuilt).every((v) => v >= 0)).toBe(true);
  });
});

describe("the staff credit ceiling", () => {
  // The cases above have been selling from this shelf; put enough water back that a ₹20 bill
  // is never refused for the wrong reason.
  beforeAll(async () => {
    await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "water", qty: 60, kind: "adjustment", refType: "test", refId: "credit-topup" }]));
  });

  const STAFF = (id: string, name: string) => ({ kind: "staff" as const, id, name });
  const oneWater = (payer?: { kind: "patient" | "staff" | "dept"; id: string; name: string }) =>
    ({ loc: "coffee", tender: payer ? "Staff credit" : "Cash", ...(payer ? { payer } : {}), lines: [{ it: "water", qty: 1 }] });

  it("lets a bill land exactly on the ceiling", async () => {
    await given.bill(app.db, { loc: "coffee", total: 2980, payer: STAFF("RC-2088", "Suresh Muthu · Stores") });
    const r = await pay("u1", oneWater(STAFF("RC-2088", "Suresh Muthu · Stores")));    // water is ₹20 on list B
    expect(r.statusCode, r.body).toBe(200);
  });

  it("refuses the rupee after it, in the words the counter's screen already uses", async () => {
    await given.bill(app.db, { loc: "coffee", total: 2990, payer: STAFF("RC-1902", "Vinoth Prakash · Kitchen") });
    const before = (await app.db.select().from(s.bills)).length;

    const r = await pay("u1", oneWater(STAFF("RC-1902", "Vinoth Prakash · Kitchen")));

    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("₹3,010.00 breaches the ₹3,000 staff credit limit for Vinoth Prakash · Kitchen. Take another tender or split the bill.");
    expect(r.json().error.details).toEqual({ taken: 2990, room: 10 });
    expect((await app.db.select().from(s.bills)).length).toBe(before);      // refused writes nothing
  });

  it("counts the person, not the counter, and leaves other payers alone", async () => {
    // Charged at the kiosk, not this till — the ceiling belongs to the staff member.
    await given.bill(app.db, { loc: "kiosk", total: 2995, payer: STAFF("RC-3120", "Ramesh Kumar · F&B") });
    expect((await pay("u1", oneWater(STAFF("RC-3120", "Ramesh Kumar · F&B")))).statusCode).toBe(422);
    // A different staff member has their own room.
    expect((await pay("u1", oneWater(STAFF("RC-4471", "Kavitha Raman · F&B")))).statusCode).toBe(200);
  });

  it("counts this month only", async () => {
    const lastMonth = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await given.bill(app.db, { loc: "coffee", total: 2999, payer: STAFF("RC-4471", "Kavitha Raman · F&B"), at: lastMonth });
    const r = await pay("u1", oneWater(STAFF("RC-4471", "Kavitha Raman · F&B")));
    expect(r.statusCode, r.body).toBe(200);
  });

  it("ignores the ceiling for a tender that takes money now", async () => {
    await given.bill(app.db, { loc: "coffee", total: 5000, payer: STAFF("RC-2088", "Suresh Muthu · Stores") });
    expect((await pay("u1", oneWater())).statusCode).toBe(200);                                    // Cash
  });

  it("counts credit, not money already taken, when a cash bill carries a staff member's name", async () => {
    // ₹2,999 that was paid for at the till is not credit, so it must not eat their room.
    await given.bill(app.db, { loc: "coffee", total: 2999, tender: "Cash", payer: STAFF("RC-4471", "Kavitha Raman · F&B") });
    const r = await pay("u1", oneWater(STAFF("RC-4471", "Kavitha Raman · F&B")));
    expect(r.statusCode, r.body).toBe(200);
  });
});

describe("a sale cannot take stock another document is holding", () => {
  // The first case is caught by the *pre-check* (`coverOf` over `posRepo.rsvAt`), which already
  // nets reservations — it pins that the two voices agree. The race below is what exercises the
  // post-lock re-read, because only a concurrent writer can take a hold after the pre-check read.
  it("pins the friendlier pre-check: more than on hand less reserved is refused, and takes nothing", async () => {
    // A shop transfer out of this counter holds all but two of its water; only what is left is sellable.
    const free = await onHand("coffee", "water");
    await given.ticket(app.db, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: "kiosk", lines: [{ it: "water", qty: free - 2 }] });
    const before = (await app.db.select().from(s.stockMoves)).length;

    const over = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 3 }] });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.message).toBe("Only 2 nos of Mineral water 1L left at Coffee Shop");
    expect((await app.db.select().from(s.stockMoves)).length).toBe(before);

    const exact = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 2 }] });
    expect(exact.statusCode, exact.body).toBe(200);
  });

  it("refuses a sale the lock reveals a second document has just taken a hold on", async () => {
    // The pre-check reads before it locks, so a sale can pass it on a stale hold total. Take the
    // water's balance row lock the way every path that holds stock must, let a bill read past it,
    // then put the whole shelf on hold underneath. The sale has to fail on the post-lock re-read,
    // which is only true once that re-read nets what is held, and leave nothing behind.
    await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "water", qty: 8, kind: "adjustment", refType: "test", refId: "race-topup" }]));
    await warmPool(app.testDb!, 2);
    // The case above left a hold on this shelf, so what is sellable is on hand less that hold.
    const have = await onHand("coffee", "water");
    const free = have - ((await stockOf("u1")).rsv["coffee:water"] ?? 0);
    expect(free).toBeGreaterThan(0);
    const ticket = await given.ticket(app.db, { from: "coffee", to: "kiosk", lines: [{ it: "water", qty: free }], reserve: false });
    const billsBefore = (await app.db.select().from(s.bills)).length;
    const movesBefore = (await app.db.select().from(s.stockMoves)).length;

    const holder = app.db.transaction(async (tx) => {
      await lockBalances(tx, [{ loc: "coffee", it: "water" }]);   // the lock every holding path takes first
      await sleep(1000);                                          // the sale reads, then blocks on it
      await reserve(tx, [{ loc: "coffee", it: "water", qty: free, ticketId: ticket }]);
    });
    await sleep(50);
    const t0 = Date.now();
    // The sale's own elapsed time, not the pair's: `holder` sleeps 400 ms by itself, so timing
    // the `Promise.all` would pass however fast the bill came back.
    const saleP = pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: free }] }).then((r) => ({ r, ms: Date.now() - t0 }));
    const [{ r: sale, ms }] = await Promise.all([saleP, holder]);

    // It could only have taken that long by waiting on the lock, which is past the pre-check:
    // the refusal below is the post-lock read talking, not the friendly one.
    expect(ms).toBeGreaterThan(250);
    expect(sale.statusCode, sale.body).toBe(422);
    expect(sale.json().error).toMatchObject({ code: "rule", message: "Only 0 nos of Mineral water 1L left at Coffee Shop" });
    expect(await onHand("coffee", "water")).toBe(have);                     // the sale's moves rolled back
    expect((await app.db.select().from(s.bills)).length).toBe(billsBefore);
    // Nothing to rebuild a balance from: a refused sale leaves the ledger exactly as it found it.
    expect((await app.db.select().from(s.stockMoves)).length).toBe(movesBefore);
  });

  it("still leaves the balance cache equal to the moves that made it", async () => {
    const before = Object.fromEntries((await app.db.select().from(s.stockBalances)).map((r) => [`${r.loc}:${r.itemKey}`, r.onHand]));
    await rebuildBalances(app.db);
    expect(Object.fromEntries((await app.db.select().from(s.stockBalances)).map((r) => [`${r.loc}:${r.itemKey}`, r.onHand]))).toEqual(before);
  });
});

describe("the payer is somebody on the roster, not a word the till typed", () => {
  // The cases above have been drawing this shelf down; put enough water back that a ₹20 bill is
  // never refused for the wrong reason, and enough of it free that the holds the race above
  // left behind do not swallow the lot.
  beforeAll(async () => {
    await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "water", qty: 400, kind: "adjustment", refType: "test", refId: "roster-topup" }]));
  });
  const oneWater = (payer: { kind: "patient" | "staff" | "dept"; id: string; name: string }, tender: string) =>
    ({ loc: "coffee", tender, payer, lines: [{ it: "water", qty: 1 }] });

  it("refuses an id nobody is on, and writes nothing", async () => {
    const before = (await app.db.select().from(s.bills)).length;
    const r = await pay("u1", oneWater({ kind: "staff", id: "RC-1902-b", name: "Vinoth Prakash · Kitchen" }, "Staff credit"));
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toMatchObject({ code: "rule", message: "There is no staff member RC-1902-b on the roster" });
    expect((await app.db.select().from(s.bills)).length).toBe(before);
  });

  it("calls each kind what the tender's own refusal calls it", async () => {
    const p = await pay("u1", oneWater({ kind: "patient", id: "IP-0000", name: "Nobody At All" }, "Patient bill"));
    expect(p.statusCode).toBe(422);
    expect(p.json().error.message).toBe("There is no patient IP-0000 on the roster");
    const d = await pay("u1", oneWater({ kind: "dept", id: "CC-XX", name: "Nobody At All" }, "Dept"));
    expect(d.statusCode).toBe(422);
    expect(d.json().error.message).toBe("There is no department CC-XX on the roster");
  });

  it("writes the roster's name on the bill, not the one the till sent", async () => {
    const r = await pay("u1", oneWater({ kind: "patient", id: "IP-4488", name: "Whoever The Till Typed" }, "Patient bill"));
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.payer).toEqual({ kind: "patient", id: "IP-4488", name: "Meera Devi · Ward 2A" });
    expect(b.message).toBe(`Bill ${b.result.no} · ₹20.00 posted to Meera Devi · Ward 2A`);
    // And in the table, because that is the name the ward is billed against months later.
    const [head] = await app.db.select().from(s.bills).where(eq(s.bills.no, b.result.no));
    expect(head.payerName).toBe("Meera Devi · Ward 2A");
  });

  it("cannot be given a fresh ceiling by suffixing the id", async () => {
    // Vinoth is already at ₹2,990 of his ₹3,000 (the ceiling cases above), so his own id is
    // refused. Before the roster check, "RC-1902-b" was simply a payer nobody had billed yet —
    // a whole second ceiling for the same person, one keystroke away.
    const real = await pay("u1", oneWater({ kind: "staff", id: "RC-1902", name: "Vinoth Prakash · Kitchen" }, "Staff credit"));
    expect(real.statusCode).toBe(422);
    expect(real.json().error.message).toContain("staff credit limit");
    const suffixed = await pay("u1", oneWater({ kind: "staff", id: "RC-1902-b", name: "Vinoth Prakash · Kitchen" }, "Staff credit"));
    expect(suffixed.statusCode).toBe(422);
    expect(suffixed.json().error.message).toBe("There is no staff member RC-1902-b on the roster");
  });

  it("refuses a payer the roster has retired", async () => {
    await app.db.insert(s.payers).values({ kind: "staff", id: "RC-7788", name: "Left The Hospital", active: false });
    const r = await pay("u1", oneWater({ kind: "staff", id: "RC-7788", name: "Left The Hospital" }, "Staff credit"));
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("There is no staff member RC-7788 on the roster");
  });
});

describe("two tills cannot both fit under one ceiling", () => {
  // Enough water for both ₹1,600 carts, so the pair races on the ceiling and not on the shelf.
  beforeAll(async () => {
    await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "water", qty: 400, kind: "adjustment", refType: "test", refId: "credit-race-topup" }]));
  });

  it("serialises the credit read per payer: one bill lands, the other is refused", async () => {
    // ₹1,600 each against a ₹3,000 ceiling: either alone fits and both together do not. The
    // ceiling is a sum over bills that are already committed, so without `lockStaffCredit` both
    // tills read ₹0 taken before either has written, both pass, and the hospital carries ₹3,200
    // of credit it never agreed to. Proven by commenting the advisory lock out: both answer 200.
    await app.db.insert(s.payers).values({ kind: "staff", id: "RC-9001", name: "Priya Anand · Housekeeping" });
    const payer = { kind: "staff" as const, id: "RC-9001", name: "Priya Anand · Housekeeping" };
    await warmPool(app.testDb!, 2);
    const body: PayBody = { loc: "coffee", tender: "Staff credit", payer, lines: [{ it: "water", qty: 80 }] };   // 80 × ₹20 = ₹1,600
    const billsBefore = (await app.db.select().from(s.bills)).length;

    const [a, b] = await Promise.all([pay("u1", body), pay("u1", body)]);

    expect([a.statusCode, b.statusCode].sort(), `${a.body} | ${b.body}`).toEqual([200, 422]);
    const loser = a.statusCode === 422 ? a : b;
    expect(loser.json().error).toMatchObject({
      code: "rule",
      message: "₹3,200.00 breaches the ₹3,000 staff credit limit for Priya Anand · Housekeeping. Take another tender or split the bill.",
      details: { taken: 1600, room: 1400 },
    });
    // One bill, one bill's worth of credit — the refused one left nothing behind.
    expect((await app.db.select().from(s.bills)).length).toBe(billsBefore + 1);
  });

  it("still leaves the balance cache equal to the moves that made it", async () => {
    const before = Object.fromEntries((await app.db.select().from(s.stockBalances)).map((r) => [`${r.loc}:${r.itemKey}`, r.onHand]));
    await rebuildBalances(app.db);
    expect(Object.fromEntries((await app.db.select().from(s.stockBalances)).map((r) => [`${r.loc}:${r.itemKey}`, r.onHand]))).toEqual(before);
  });
});
