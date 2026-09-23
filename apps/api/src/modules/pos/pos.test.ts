import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import type { PayerKind } from "@rch/contract";
import { BillSchema, StockResponseSchema } from "@rch/contract";
import { dmy, istDate } from "@rch/domain";
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
type PayBody = { loc: string; tender: string; payer?: { kind: string; id: string; name: string }; lines: PayLine[]; customerName?: string; customerPhone?: string };

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

describe("POST /bills - the counter sale", () => {
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

  it("wrote the bill, its lines and its moves - and no history, because a bill has none", async () => {
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

  it("names the payer on a credit tender - with the name the roster carries", async () => {
    const r = await pay("u1", { loc: "coffee", tender: "Doctor credit", payer: { kind: "doctor", id: "DR-204", name: "Dr Menon, OP" }, lines: [{ it: "juice", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.payer).toEqual({ kind: "doctor", id: "DR-204", name: "Dr S. Menon · Paediatrics" });
    expect(b.message).toBe(`Bill ${b.result.no} · ₹16.00 · 20% doctor discount, ₹4.00 off posted to Dr S. Menon · Paediatrics`);
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

  it("wants a doctor before it takes a doctor credit", async () => {
    await rejects({ loc: "coffee", tender: "Doctor credit", lines: [{ it: "juice", qty: 1 }] }, "Choose a doctor before taking a doctor credit");
  });
  it("wants a staff member before it takes a staff credit", async () => {
    await rejects({ loc: "coffee", tender: "Staff credit", lines: [{ it: "juice", qty: 1 }] }, "Choose a staff member before taking a staff credit");
  });
  it("wants a department before it takes a dept bill", async () => {
    await rejects({ loc: "coffee", tender: "Dept", lines: [{ it: "juice", qty: 1 }] }, "Choose a department before taking a dept");
  });
  it("refuses a staff credit posted to somebody who is not staff", async () => {
    // The tender and the payer have to agree, or the bill runs up a balance the ceiling never
    // measures: it counts staff payers, and this one would land on a consultant's account.
    await rejects(
      { loc: "coffee", tender: "Staff credit", payer: { kind: "doctor", id: "DR-118", name: "Dr A. Rao · Cardiology" }, lines: [{ it: "water", qty: 1 }] },
      "Choose a staff member for a staff credit - Dr A. Rao · Cardiology is not one");
  });
  it("refuses a doctor credit posted to a staff member", async () => {
    await rejects(
      { loc: "coffee", tender: "Doctor credit", payer: { kind: "staff", id: "RC-2088", name: "Suresh Muthu · Stores" }, lines: [{ it: "water", qty: 1 }] },
      "Choose a doctor for a doctor credit - Suresh Muthu · Stores is not one");
  });
  it("refuses an item the counter does not list", async () => {
    await rejects({ loc: "coffee", tender: "Cash", lines: [{ it: "puff", qty: 1 }] }, "Veg puffs is not listed at Coffee Shop");
  });
  it("answers 404 for an item the master has never heard of", async () => {
    const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "nosuch", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(404);
    expect(r.json().error.message).toBe("There is no item nosuch.");
  });
  it("refuses a made-to-order item the counter has switched off, in the switch's own words", async () => {
    // Nothing on a shelf decides a made-to-order item, so the switch is the one thing that can.
    await app.db.insert(s.availabilityOverrides).values({ loc: "coffee", itemKey: "chai", reason: "Tea urn is being descaled" });
    try {
      await rejects({ loc: "coffee", tender: "Cash", lines: [{ it: "chai", qty: 1 }] }, "Masala tea is not available at Coffee Shop - Tea urn is being descaled");
    } finally {
      await app.db.delete(s.availabilityOverrides).where(and(eq(s.availabilityOverrides.loc, "coffee"), eq(s.availabilityOverrides.itemKey, "chai")));
    }
  });
  it("refuses more of a traded item than the shelf holds", async () => {
    await rejects({ loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 99 }] }, "Only 9 nos of Mineral water 1L left at Coffee Shop");
  });
  it("refuses a tender that is not one of the six - 400 at the door, not a rule", async () => {
    // "staff credit" is not "Staff credit": a tender is a closed set on the wire, so a near
    // miss is a malformed request, never a bill settled under a name nothing else recognises.
    const r = await pay("u1", { loc: "coffee", tender: "staff credit", payer: { kind: "staff", id: "E-1", name: "Anitha" }, lines: [{ it: "juice", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe("validation");
  });
});

describe("a made-to-order sale moves no stock", () => {
  it("sells a cappuccino with the Coffee Shop's milk at zero, and posts no move for it", async () => {
    // The seed leaves the Coffee Shop with no milk: a drink made at the till is sold regardless.
    expect(await onHand("coffee", "milk")).toBe(0);
    const cups = await onHand("coffee", "cup");
    const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "capp", qty: 100 }] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.tot).toBe(7500);
    expect(b.result.lines).toEqual([{ it: "capp", qty: 100, rate: 75 }]);
    expect(b.message).toBe(`Bill ${b.result.no} · ₹7500.00 collected at Coffee Shop`);

    const moves = await app.db.select().from(s.stockMoves).where(and(eq(s.stockMoves.refType, "bill"), eq(s.stockMoves.refId, b.result.no)));
    expect(moves).toEqual([]);
    expect(await onHand("coffee", "milk")).toBe(0);
    expect(await onHand("coffee", "cup")).toBe(cups);
    // No shelf line is created for a drink no shelf carries.
    const rows = await app.db.select().from(s.stockBalances).where(and(eq(s.stockBalances.loc, "coffee"), eq(s.stockBalances.itemKey, "capp")));
    expect(rows).toHaveLength(0);
  });
});

describe("the printed MRP is the ceiling at the till too", () => {
  const savePrice = async (price: number) => app.inject({
    method: "PUT", url: "/api/v1/outlet-prices",
    headers: { ...(await authHeaders(app, "u2")), "idempotency-key": randomUUID() },
    payload: { changes: [{ loc: "coffee", it: "juice", price }] },
  });

  it("saves a list price above the MRP, and the till still charges the MRP", async () => {
    const before = (await app.db.select().from(s.priceListItems).where(and(eq(s.priceListItems.listId, "PL-002"), eq(s.priceListItems.itemKey, "juice"))))[0]!;
    const saved = await savePrice(25);
    expect(saved.statusCode, saved.body).toBe(200);
    try {
      const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }] });
      expect(r.statusCode, r.body).toBe(200);
      const b = r.json();
      expect(b.result.lines).toEqual([{ it: "juice", qty: 1, rate: 20 }]);   // MRP 20, list 25
      expect(b.result.tot).toBe(20);
      expect(b.message).toBe(`Bill ${b.result.no} · ₹20.00 collected at Coffee Shop`);
    } finally {
      expect((await savePrice(before.price)).statusCode).toBe(200);
    }
  });
});

describe("a sale needs a price - an outlet on no list, or an item unpriced on its list, is refused, not billed at ₹0", () => {
  it("refuses the whole cart when the outlet carries no price list at all", async () => {
    // The admin opens a new outlet on no list; every sale there must wait for the manager to
    // attach one, not price at ₹0 while still taking stock off the shelf.
    await app.db.update(s.locations).set({ priceListId: null }).where(eq(s.locations.key, "kiosk"));
    try {
      const billsBefore = (await app.db.select().from(s.bills)).length;
      const movesBefore = (await app.db.select().from(s.stockMoves)).length;

      const r = await pay("u6", { loc: "kiosk", tender: "Cash", lines: [{ it: "juice", qty: 1 }] });

      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error).toMatchObject({ code: "rule", message: "Refused - Snack Kiosk is on no price list; attach one from Prices before selling" });
      expect((await app.db.select().from(s.bills)).length).toBe(billsBefore);
      expect((await app.db.select().from(s.stockMoves)).length).toBe(movesBefore);
    } finally {
      await app.db.update(s.locations).set({ priceListId: "PL-001" }).where(eq(s.locations.key, "kiosk"));
    }
  });

  it("refuses one item that is listed at the counter but carries no price on the outlet's own list", async () => {
    // The fixture prices every menu item on both lists, so make one gap in the kiosk's own list
    // (PL-001) the way the MRP-drift case above makes one in the price - by editing the table
    // directly, then putting it back.
    const before = (await app.db.select().from(s.priceListItems).where(and(eq(s.priceListItems.listId, "PL-001"), eq(s.priceListItems.itemKey, "puff"))))[0];
    await app.db.delete(s.priceListItems).where(and(eq(s.priceListItems.listId, "PL-001"), eq(s.priceListItems.itemKey, "puff")));
    try {
      const billsBefore = (await app.db.select().from(s.bills)).length;

      const r = await pay("u6", { loc: "kiosk", tender: "Cash", lines: [{ it: "puff", qty: 1 }] });

      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error).toMatchObject({ code: "rule", message: "Refused - Veg puffs has no price at Snack Kiosk" });
      expect((await app.db.select().from(s.bills)).length).toBe(billsBefore);
    } finally {
      await app.db.insert(s.priceListItems).values(before);
    }
  });

  it("still sells normally at a listed, priced outlet", async () => {
    const r = await pay("u6", { loc: "kiosk", tender: "Cash", lines: [{ it: "juice", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.lines).toEqual([{ it: "juice", qty: 1, rate: 18 }]);   // list A
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

  it("a sale the post-lock re-read refuses does not burn a bill number", async () => {
    // Same shape as the case above, but about the counter rather than the shelf. A bill used to
    // take its number before the locks were taken, so the refusal below rolled back a number the
    // series had already moved past - every one of them a gap in the till roll somebody has to
    // explain to an auditor. The number is taken last now, so the next real sale gets it.
    await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "bisc", qty: 4, kind: "adjustment", refType: "test", refId: "no-burn-topup" }]));
    await warmPool(app.testDb!, 2);
    const have = await onHand("coffee", "bisc");
    expect(have).toBeGreaterThan(0);
    const [seq] = await app.db.select().from(s.sequences).where(eq(s.sequences.kind, "bill"));
    const waiting = seq!.next;

    const drained = app.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from stock_balances where loc = 'coffee' and item_key = 'bisc' for update`);
      await sleep(1000);
      await postMoves(tx, [{ loc: "coffee", it: "bisc", qty: -have, kind: "adjustment", refType: "test", refId: "no-burn-drain" }]);
    });
    await sleep(50);
    const refused = pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "bisc", qty: have }] });
    const [r] = await Promise.all([refused, drained]);
    expect(r.statusCode, r.body).toBe(422);

    // The next sale to actually go through takes the number the refused one was standing on.
    await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "bisc", qty: 1, kind: "adjustment", refType: "test", refId: "no-burn-refill" }]));
    const sold = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "bisc", qty: 1 }] });
    expect(sold.statusCode, sold.body).toBe(200);
    expect(sold.json().result.no).toBe(`CF/${waiting}`);
  });

  it("does not hold the hospital's bill counter while it waits for a shelf", async () => {
    // The half of the reorder above that can actually be observed. A sale queued behind a shelf
    // used to be sitting on the one `sequences` row every till in the hospital draws its bill
    // number from, so one slow counter froze the others. The kiosk's sale below is behind
    // nothing at all and must therefore be numbered *before* the coffee shop's, not after it.
    await app.db.transaction((tx) => postMoves(tx, [
      { loc: "coffee", it: "water", qty: 5, kind: "adjustment", refType: "test", refId: "convoy-coffee" },
      { loc: "kiosk", it: "water", qty: 5, kind: "adjustment", refType: "test", refId: "convoy-kiosk" },
    ]));
    await warmPool(app.testDb!, 3);

    const holder = app.db.transaction(async (tx) => {
      await lockBalances(tx, [{ loc: "coffee", it: "water" }]);   // the coffee shop's shelf, held
      await sleep(1000);
    });
    await sleep(50);
    const queued = pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    await sleep(250);                                              // long enough that it is on the shelf lock
    const free = await pay("u6", { loc: "kiosk", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const [slow] = await Promise.all([queued, holder]);

    expect(free.statusCode, free.body).toBe(200);
    expect(slow.statusCode, slow.body).toBe(200);
    const n = (r: { json(): { result: { no: string } } }) => Number(r.json().result.no.split("/")[1]);
    expect(n(free)).toBeLessThan(n(slow));
  });

  it("lets exactly one of two tills sell the last units", async () => {
    await app.db.transaction(async (tx) => {
      await postMoves(tx, [{ loc: "coffee", it: "bisc", qty: 6, kind: "opening", refType: "test", refId: "bisc-delivery" }]);
    });
    // Without this the second sale waits for a socket instead of for the balance lock, and
    // begins after the first has committed: the race never happens and the case passes with the
    // lock taken out.
    await warmPool(app.testDb!, 2);
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
  const oneWater = (payer?: { kind: PayerKind; id: string; name: string }) =>
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
    expect(r.json().error.message).toBe("₹3,010.00 breaches the ₹3,000 credit limit for Vinoth Prakash · Kitchen. Settle the account, take another tender, or split the bill.");
    expect(r.json().error.details).toEqual({ outstanding: 2990, limit: 3000 });
    expect((await app.db.select().from(s.bills)).length).toBe(before);      // refused writes nothing
  });

  it("counts the person, not the counter, and leaves other payers alone", async () => {
    // Charged at the kiosk, not this till - the ceiling belongs to the staff member.
    await given.bill(app.db, { loc: "kiosk", total: 2995, payer: STAFF("RC-3120", "Ramesh Kumar · F&B") });
    expect((await pay("u1", oneWater(STAFF("RC-3120", "Ramesh Kumar · F&B")))).statusCode).toBe(422);
    // A different staff member has their own room.
    expect((await pay("u1", oneWater(STAFF("RC-4471", "Kavitha Raman · F&B")))).statusCode).toBe(200);
  });

  it("counts last month too - a debt is not forgiven by the calendar turning", async () => {
    // The rule this replaced measured a calendar month, because nothing but a same-day void
    // could bring a balance down. Now the only thing that clears a debt is paying it, so an
    // unsettled bill from six weeks ago is still exposure and the ceiling still counts it.
    // Their own payer: every case in this describe shares one database, and a balance left on a
    // fixture staff member is a ceiling the next case trips over for the wrong reason.
    await app.db.insert(s.payers).values({ kind: "staff", id: "RC-9201", name: "Anitha Rao · Pharmacy" });
    const lastMonth = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await given.bill(app.db, { loc: "coffee", total: 2999, payer: STAFF("RC-9201", "Anitha Rao · Pharmacy"), at: lastMonth });
    const r = await pay("u1", oneWater(STAFF("RC-9201", "Anitha Rao · Pharmacy")));
    expect(r.statusCode, r.body).toBe(422);
  });

  it("gives the room back once the balance is settled", async () => {
    // The whole reason the ceiling stopped being a calendar month: paying is what clears a debt,
    // and the room comes back the moment it is paid rather than on the first of next month.
    await app.db.insert(s.payers).values({ kind: "staff", id: "RC-9202", name: "Mohan Das · Physiotherapy" });
    const payer = STAFF("RC-9202", "Mohan Das · Physiotherapy");
    await given.bill(app.db, { loc: "coffee", total: 2990, payer });
    expect((await pay("u1", oneWater(payer))).statusCode).toBe(422);
    await given.settlement(app.db, { payer, amount: 2990 });
    const r = await pay("u1", oneWater(payer));
    expect(r.statusCode, r.body).toBe(200);
  });

  it("refuses nothing at all for a party the manager gave no ceiling", async () => {
    // A department is seeded with no limit. `null` is not zero: nothing it is ever charged
    // breaches anything, which is what "no limit" has to mean for it to be worth having.
    const dept = { kind: "dept" as const, id: "CC-NUR", name: "Nursing" };
    await given.bill(app.db, { loc: "coffee", total: 99_000, tender: "Dept", payer: dept });
    const r = await pay("u1", { loc: "coffee", tender: "Dept", payer: dept, lines: [{ it: "water", qty: 1 }] });
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
  // nets reservations - it pins that the two voices agree. The race below is what exercises the
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
  const oneWater = (payer: { kind: PayerKind; id: string; name: string }, tender: string) =>
    ({ loc: "coffee", tender, payer, lines: [{ it: "water", qty: 1 }] });

  it("refuses an id nobody is on, and writes nothing", async () => {
    const before = (await app.db.select().from(s.bills)).length;
    const r = await pay("u1", oneWater({ kind: "staff", id: "RC-1902-b", name: "Vinoth Prakash · Kitchen" }, "Staff credit"));
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toMatchObject({ code: "rule", message: "There is no staff member RC-1902-b on the roster" });
    expect((await app.db.select().from(s.bills)).length).toBe(before);
  });

  it("calls each kind what the tender's own refusal calls it", async () => {
    const st = await pay("u1", oneWater({ kind: "staff", id: "RC-0000", name: "Nobody At All" }, "Staff credit"));
    expect(st.statusCode).toBe(422);
    expect(st.json().error.message).toBe("There is no staff member RC-0000 on the roster");
    const d = await pay("u1", oneWater({ kind: "dept", id: "CC-XX", name: "Nobody At All" }, "Dept"));
    expect(d.statusCode).toBe(422);
    expect(d.json().error.message).toBe("There is no department CC-XX on the roster");
    const c = await pay("u1", oneWater({ kind: "doctor", id: "DR-000", name: "Nobody At All" }, "Doctor credit"));
    expect(c.statusCode).toBe(422);
    expect(c.json().error.message).toBe("There is no doctor DR-000 on the roster");
  });

  it("writes the roster's name on the bill, not the one the till sent", async () => {
    const r = await pay("u1", oneWater({ kind: "dept", id: "CC-NUR", name: "Whoever The Till Typed" }, "Dept"));
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.payer).toEqual({ kind: "dept", id: "CC-NUR", name: "Nursing" });
    expect(b.message).toBe(`Bill ${b.result.no} · ₹20.00 posted to Nursing`);
    // And in the table, because that is the name the ward is billed against months later.
    const [head] = await app.db.select().from(s.bills).where(eq(s.bills.no, b.result.no));
    expect(head.payerName).toBe("Nursing");
  });

  it("cannot be given a fresh ceiling by suffixing the id", async () => {
    // Vinoth is already at ₹2,990 of his ₹3,000 (the ceiling cases above), so his own id is
    // refused. Before the roster check, "RC-1902-b" was simply a payer nobody had billed yet -
    // a whole second ceiling for the same person, one keystroke away.
    const real = await pay("u1", oneWater({ kind: "staff", id: "RC-1902", name: "Vinoth Prakash · Kitchen" }, "Staff credit"));
    expect(real.statusCode).toBe(422);
    expect(real.json().error.message).toContain("credit limit");
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

// ---- bill void ----
/**
 * POST /bills/:no/void - the same-day door out of a mis-keyed bill.
 *
 * What the cases below are about is the shape of the undo, not the arithmetic of the sale: one
 * positive reversal per move the sale posted, each naming the row it cancels, the bill left on
 * the table with a stamp on it, and the two sums that count money - the staff-credit ceiling and
 * the dashboard's columns - learning to skip it.
 */
describe("POST /bills/:no/void - the manager takes a bill back", () => {
  const voidBill = async (userId: string, no: string, reason: string, key: string = randomUUID()) =>
    app.inject({
      method: "POST", url: `/api/v1/bills/${encodeURIComponent(no)}/void`,
      headers: { ...(await authHeaders(app, userId)), "idempotency-key": key }, payload: { reason },
    });
  const movesOf = async (no: string, kind: "sale" | "reversal") =>
    app.db.select().from(s.stockMoves)
      .where(and(eq(s.stockMoves.refType, "bill"), eq(s.stockMoves.refId, no), eq(s.stockMoves.kind, kind)))
      .orderBy(asc(s.stockMoves.id));

  // Every case here sells something first, and the shelves above have been drawn down all file.
  beforeAll(async () => {
    await app.db.transaction((tx) => postMoves(tx, [
      { loc: "coffee", it: "water", qty: 400, kind: "adjustment", refType: "test", refId: "void-topup" },
      { loc: "coffee", it: "juice", qty: 200, kind: "adjustment", refType: "test", refId: "void-topup" },
    ]));
  });

  it("puts every line back on the shelf and marks the bill voided", async () => {
    const before = await stockOf("u1");
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 3 }, { it: "juice", qty: 2 }] });
    expect(sale.statusCode, sale.body).toBe(200);
    const no = sale.json().result.no as string;
    expect(await onHand("coffee", "water")).toBe(before.stock.coffee.water - 3);

    const r = await voidBill("u2", no, "Wrong tender - customer paid cash");
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(BillSchema.safeParse(b.result).success, JSON.stringify(b.result)).toBe(true);
    expect(b.result.no).toBe(no);
    expect(b.result.voided).toBe(true);
    expect(b.result.voidReason).toBe("Wrong tender - customer paid cash");
    // Nothing about the bill itself is rewritten: it is still the bill that was printed.
    expect(b.result.tot).toBe(100);
    expect(b.result.lines).toEqual([{ it: "water", qty: 3, rate: 20 }, { it: "juice", qty: 2, rate: 20 }]);
    expect(b.message).toBe(`${no} voided - 5 nos back on the shelf at Coffee Shop`);

    expect(await onHand("coffee", "water")).toBe(before.stock.coffee.water);
    expect(await onHand("coffee", "juice")).toBe(before.stock.coffee.juice);
    const [head] = await app.db.select().from(s.bills).where(eq(s.bills.no, no));
    expect(head.voidedAt).toBeInstanceOf(Date);
    expect(head.voidedBy).toBe("u2");
    expect(head.voidReason).toBe("Wrong tender - customer paid cash");
  });

  it("posts one positive reversal per sale move, each pointing at the move it reverses", async () => {
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 2 }, { it: "juice", qty: 1 }] });
    const no = sale.json().result.no as string;
    const sold = await movesOf(no, "sale");

    expect((await voidBill("u2", no, "Rang up twice")).statusCode).toBe(200);

    const back = await movesOf(no, "reversal");
    expect(back).toHaveLength(sold.length);
    expect(back.every((m) => m.qty > 0)).toBe(true);
    expect(back.map((m) => [m.itemKey, m.qty])).toEqual(sold.map((m) => [m.itemKey, -m.qty]));
    expect(back.map((m) => m.reversesId)).toEqual(sold.map((m) => m.id));
    expect(back.every((m) => m.loc === "coffee" && m.byUser === "u2")).toBe(true);
    // And the sale's own rows are untouched: the ledger is append-only, an undo is another move.
    expect(sold.every((m) => m.reversesId === null)).toBe(true);
  });

  it("puts back only what the sale took - a made-to-order line took nothing", async () => {
    const water = await onHand("coffee", "water");
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "capp", qty: 4 }, { it: "water", qty: 1 }] });
    expect(sale.statusCode, sale.body).toBe(200);
    const no = sale.json().result.no as string;
    expect((await movesOf(no, "sale")).map((m) => [m.itemKey, m.qty])).toEqual([["water", -1]]);
    expect(await onHand("coffee", "water")).toBe(water - 1);

    const r = await voidBill("u2", no, "Customer changed their mind before it was poured");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().message).toBe(`${no} voided - 1 nos back on the shelf at Coffee Shop`);

    const back = await movesOf(no, "reversal");
    expect(back.map((m) => [m.itemKey, m.qty])).toEqual([["water", 1]]);
    expect(await onHand("coffee", "water")).toBe(water);
    // The bill on the wire still reads as what was sold.
    expect(r.json().result.lines).toEqual([{ it: "capp", qty: 4, rate: 75 }, { it: "water", qty: 1, rate: 20 }]);
  });

  it("voids a bill of made-to-order lines alone, posting nothing", async () => {
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "chai", qty: 2 }] });
    expect(sale.statusCode, sale.body).toBe(200);
    const no = sale.json().result.no as string;
    expect(await movesOf(no, "sale")).toEqual([]);

    const r = await voidBill("u2", no, "Rang up at the wrong counter");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.voided).toBe(true);
    expect(r.json().message).toBe(`${no} voided`);
    expect(await movesOf(no, "reversal")).toEqual([]);
  });

  it("needs the bill number percent-encoded, and 404s the bare slash form", async () => {
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const no = sale.json().result.no as string;
    expect(no).toContain("/");

    // The bare form splits into two path segments and matches no route at all.
    const bare = await app.inject({
      method: "POST", url: `/api/v1/bills/${no}/void`,
      headers: { ...(await authHeaders(app, "u2")), "idempotency-key": randomUUID() }, payload: { reason: "Bare slash" },
    });
    expect(bare.statusCode).toBe(404);
    const [untouched] = await app.db.select().from(s.bills).where(eq(s.bills.no, no));
    expect(untouched.voidedAt).toBeNull();

    const encoded = await voidBill("u2", no, "Percent-encoded");
    expect(encoded.statusCode, encoded.body).toBe(200);
    expect(encoded.json().result.no).toBe(no);
  });

  it("404s a bill number that is not there", async () => {
    const r = await voidBill("u2", "CF/404404", "Never existed");
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toMatchObject({ code: "not_found", message: "There is no bill CF/404404." });
  });

  it("requires a reason", async () => {
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const no = sale.json().result.no as string;
    const r = await voidBill("u2", no, "   ");
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: "rule", message: "Give a reason for voiding this bill" });
    const [head] = await app.db.select().from(s.bills).where(eq(s.bills.no, no));
    expect(head.voidedAt).toBeNull();
    expect(await movesOf(no, "reversal")).toEqual([]);
  });

  it("refuses a bill that was voided already", async () => {
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const no = sale.json().result.no as string;
    expect((await voidBill("u2", no, "Keyed the wrong outlet")).statusCode).toBe(200);

    const again = await voidBill("u2", no, "Keyed the wrong outlet");
    expect(again.statusCode).toBe(422);
    expect(again.json().error).toMatchObject({ code: "rule", message: `${no} has already been voided` });
    // And the stock went back exactly once.
    expect(await movesOf(no, "reversal")).toHaveLength(1);
  });

  /**
   * The day boundary, on a fixed clock.
   *
   * "Same day" is the hospital's, not the host's, and the two only disagree in the six and a
   * half hours between 18:30 UTC and midnight UTC. A test that read the wall clock would prove
   * that on some hosts at some hours and nothing at all the rest of the time, so both cases
   * below pin an instant and pick values where **UTC-day equality and IST-day equality point
   * opposite ways** - an implementation that compared UTC dates fails each of them on every host
   * at every hour. Only `Date` is faked: the pool, the server and pg still run on real timers.
   */
  const atClock = async <T>(iso: string, run: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    try { return await run(); } finally { vi.useRealTimers(); }
  };

  it("voids a bill taken at 23:59 IST while it is still that IST day", async () => {
    // 23:59:30 IST on 11-Sep - a minute and a half of the hospital's day left.
    await atClock("2026-09-11T18:29:30.000Z", async () => {
      // The last bill of the day is the one most likely to be wrong, and the till that took it
      // is still standing there. 23:59 IST, the same UTC day as now.
      const late = await given.bill(app.db, { loc: "coffee", total: 40, tender: "Cash", at: new Date("2026-09-11T18:29:00.000Z") });
      const r = await voidBill("u2", late, "Last bill of the shift, wrong item");
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().message).toBe(`${late} voided`);    // given.bill posts no moves, nothing came back

      // And the morning's bill from the *same hospital day*, which fell on the UTC day before:
      // 00:30 IST on 11-Sep is 19:00 UTC on the 10th. A UTC-day comparison refuses this one.
      const morning = await given.bill(app.db, { loc: "coffee", total: 40, tender: "Cash", at: new Date("2026-09-10T19:00:00.000Z") });
      const m = await voidBill("u2", morning, "Wrong item, spotted at the end of the shift");
      expect(m.statusCode, m.body).toBe(200);
    });
  });

  it("refuses a bill from yesterday, naming the day it belongs to", async () => {
    // 00:05 IST on 12-Sep - five minutes into the new hospital day, still 11-Sep in UTC.
    await atClock("2026-09-11T18:35:00.000Z", async () => {
      // 23:55 IST on 11-Sep: the same UTC day as now, and the hospital day before it. A
      // UTC-day comparison would let this through - which is the whole point of the hour.
      const yday = new Date("2026-09-11T18:25:00.000Z");
      const no = await given.bill(app.db, { loc: "coffee", total: 40, tender: "Cash", at: yday });
      const r = await voidBill("u2", no, "Spotted it at the day-end count");
      expect(r.statusCode).toBe(422);
      expect(dmy(istDate(yday))).toBe("11-Sep-2026");
      expect(r.json().error).toMatchObject({
        code: "rule",
        message: `${no} was taken on 11-Sep-2026 - a bill can only be voided on the day it was billed; write the stock back on with an adjustment instead`,
      });
      const [head] = await app.db.select().from(s.bills).where(eq(s.bills.no, no));
      expect(head.voidedAt).toBeNull();
    });
  });

  it("is absent for every role but the manager", async () => {
    const no = await given.bill(app.db, { loc: "coffee", total: 40, tender: "Cash" });
    // The till that took the bill is exactly the party that must not be able to unsell it.
    for (const who of ["u1", "u3", "u4", "u5"]) {
      const r = await voidBill(who, no, "Not mine to take back");
      expect(r.statusCode, `${who} reached the void`).toBe(404);
    }
    const [head] = await app.db.select().from(s.bills).where(eq(s.bills.no, no));
    expect(head.voidedAt).toBeNull();
  });

  it("takes a bill off a staff member's account - a sale that would have breached now lands", async () => {
    await app.db.insert(s.payers).values({ kind: "staff", id: "RC-9102", name: "Deepa Raman · Radiology" });
    const payer = { kind: "staff" as const, id: "RC-9102", name: "Deepa Raman · Radiology" };
    const mistake = await given.bill(app.db, { loc: "coffee", total: 2990, payer });
    const cart: PayBody = { loc: "coffee", tender: "Staff credit", payer, lines: [{ it: "water", qty: 1 }] };

    const breached = await pay("u1", cart);
    expect(breached.statusCode).toBe(422);
    expect(breached.json().error.message).toContain("credit limit");

    const v = await voidBill("u2", mistake, "Charged to the wrong staff member");
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().message).toBe(`${mistake} voided - ₹2,990.00 is off Deepa Raman · Radiology's account`);

    const now = await pay("u1", cart);
    expect(now.statusCode, now.body).toBe(200);
  });

  it("leaves a voided bill out of the dashboard's takings", async () => {
    const takings = async () => {
      const r = await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u2") });
      expect(r.statusCode, r.body).toBe(200);
      return (r.json().sales as Record<string, number>[]).reduce((sum, row) => sum + Object.values(row).reduce((a, b) => a + b, 0), 0);
    };
    const before = await takings();
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 5 }] });
    const no = sale.json().result.no as string;
    expect(await takings()).toBeCloseTo(before + 100, 2);

    expect((await voidBill("u2", no, "Rang up on the wrong terminal")).statusCode).toBe(200);
    expect(await takings()).toBeCloseTo(before, 2);
  });

  it("GET /bills and the snapshot carry the voided flag and the reason", async () => {
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const no = sale.json().result.no as string;
    expect((await voidBill("u2", no, "Customer walked out")).statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/v1/bills", headers: await authHeaders(app, "u2") });
    expect(list.statusCode, list.body).toBe(200);
    const listed = list.json() as { no: string; voided?: boolean; voidReason?: string }[];
    expect(listed.find((b) => b.no === no)).toMatchObject({ voided: true, voidReason: "Customer walked out" });
    // And a bill nobody voided carries neither key at all, so a screen asks `if (b.voided)`.
    const clean = listed.find((b) => b.no !== no && b.voided === undefined)!;
    expect(clean).toBeTruthy();
    expect(Object.keys(clean)).not.toContain("voidReason");

    const snap = await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u2") });
    const fromSnapshot = (snap.json().bills as { no: string; voided?: boolean; voidReason?: string }[]).find((b) => b.no === no);
    expect(fromSnapshot).toMatchObject({ voided: true, voidReason: "Customer walked out" });
  });

  it("writes one document_history row and puts no hist on the wire", async () => {
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const no = sale.json().result.no as string;
    expect(await app.db.select().from(s.documentHistory).where(eq(s.documentHistory.docId, no))).toEqual([]);

    const r = await voidBill("u2", no, "Double scan");
    expect(r.statusCode, r.body).toBe(200);

    const hist = await app.db.select().from(s.documentHistory).where(eq(s.documentHistory.docId, no));
    expect(hist).toHaveLength(1);
    expect(hist[0].docType).toBe("bill");
    expect(hist[0].status).toBe("Voided - Double scan");
    expect(hist[0].who).toBe("Ramesh Kumar");
    // `BillSchema` has no `hist`: the badge and the reason are the whole story a bill can tell.
    expect(r.json().result).not.toHaveProperty("hist");
  });

  it("announces stock and bills, and the response carries the same array", async () => {
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const no = sale.json().result.no as string;
    const r = await voidBill("u2", no, "Wrong counter");
    expect(r.json().changed).toEqual(["stock", "bills"]);
  });

  it("two managers voiding the same bill: one lands, the other reads 'already voided'", async () => {
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 4 }] });
    const no = sale.json().result.no as string;
    const before = await onHand("coffee", "water");
    await warmPool(app.testDb!, 2);

    const [a, b] = await Promise.all([voidBill("u2", no, "Wrong tender"), voidBill("u2", no, "Wrong tender")]);

    expect([a.statusCode, b.statusCode].sort(), `${a.body} | ${b.body}`).toEqual([200, 422]);
    const loser = a.statusCode === 422 ? a : b;
    expect(loser.json().error).toMatchObject({ code: "rule", message: `${no} has already been voided` });
    // Four units of water, back exactly once: without the row lock both would post reversals.
    expect(await onHand("coffee", "water")).toBe(before + 4);
    expect(await movesOf(no, "reversal")).toHaveLength(1);
  });

  it("takes no lockBalances of its own - every reversal is positive", async () => {
    const sale = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 2 }] });
    const no = sale.json().result.no as string;
    // Put every free unit of the shelf on hold. A write that promised against this balance would
    // refuse here, the way a sale does; a reversal promises nothing, so it lands.
    const held = (await stockOf("u1")).rsv["coffee:water"] ?? 0;
    const have = await onHand("coffee", "water");
    await given.ticket(app.db, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: "kiosk", lines: [{ it: "water", qty: have - held }] });
    const cells = (await app.db.select().from(s.stockBalances)).length;

    const r = await voidBill("u2", no, "Held shelf, still a mis-key");
    expect(r.statusCode, r.body).toBe(200);
    expect((await movesOf(no, "reversal")).every((m) => m.qty > 0)).toBe(true);
    expect(await onHand("coffee", "water")).toBe(have + 2);
    // And it locked exactly the cells its own moves touch: no speculative row was created (M12).
    expect((await app.db.select().from(s.stockBalances)).length).toBe(cells);
  });

  it("still leaves the balance cache equal to the moves that made it", async () => {
    const before = Object.fromEntries((await app.db.select().from(s.stockBalances)).map((r) => [`${r.loc}:${r.itemKey}`, r.onHand]));
    await rebuildBalances(app.db);
    expect(Object.fromEntries((await app.db.select().from(s.stockBalances)).map((r) => [`${r.loc}:${r.itemKey}`, r.onHand]))).toEqual(before);
  });
});

describe("two tills cannot both fit under one ceiling", () => {
  // Enough water for both ₹1,600 carts, so the pair races on the ceiling and not on the shelf.
  beforeAll(async () => {
    await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "water", qty: 400, kind: "adjustment", refType: "test", refId: "credit-race-topup" }]));
  });

  it("serialises the credit read per payer: one bill lands, the other is refused", async () => {
    // ₹1,600 each against a ₹3,000 ceiling: either alone fits and both together do not. The
    // ceiling is a sum over bills that are already committed, so without `lockPayerCredit` both
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
      message: "₹3,200.00 breaches the ₹3,000 credit limit for Priya Anand · Housekeeping. Settle the account, take another tender, or split the bill.",
      details: { outstanding: 1600, limit: 3000 },
    });
    // One bill, one bill's worth of credit - the refused one left nothing behind.
    expect((await app.db.select().from(s.bills)).length).toBe(billsBefore + 1);
  });

  it("still leaves the balance cache equal to the moves that made it", async () => {
    const before = Object.fromEntries((await app.db.select().from(s.stockBalances)).map((r) => [`${r.loc}:${r.itemKey}`, r.onHand]));
    await rebuildBalances(app.db);
    expect(Object.fromEntries((await app.db.select().from(s.stockBalances)).map((r) => [`${r.loc}:${r.itemKey}`, r.onHand]))).toEqual(before);
  });
});

describe("POST /bills - the walk-in customer's name and phone", () => {
  const billsAs = async (userId: string) => {
    const r = await app.inject({ method: "GET", url: "/api/v1/bills", headers: await authHeaders(app, userId) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { no: string; customerName?: string; customerPhone?: string }[];
  };

  it("stores both, trimmed and the phone as its ten digits, and answers with them", async () => {
    const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }], customerName: "  Anitha S ", customerPhone: "+91 98430-22118" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json().result;
    expect(BillSchema.safeParse(b).success).toBe(true);
    expect(b).toMatchObject({ customerName: "Anitha S", customerPhone: "9843022118" });
    const [head] = await app.db.select().from(s.bills).where(eq(s.bills.no, b.no));
    expect(head).toMatchObject({ customerName: "Anitha S", customerPhone: "9843022118" });
    expect((await billsAs("u2")).find((x) => x.no === b.no)).toMatchObject({ customerName: "Anitha S", customerPhone: "9843022118" });
    // The store reads bills for their lines; whose they were is not its business.
    const store = (await billsAs("u3")).find((x) => x.no === b.no);
    expect(store).toBeTruthy();
    expect(store?.customerName).toBeUndefined();
    expect(store?.customerPhone).toBeUndefined();
  });

  it("carries neither when neither is given, and treats blank boxes as none", async () => {
    const r = await pay("u1", { loc: "coffee", tender: "UPI", lines: [{ it: "juice", qty: 1 }], customerName: "  ", customerPhone: " " });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.customerName).toBeUndefined();
    expect(r.json().result.customerPhone).toBeUndefined();
  });

  it("refuses a phone that is not one, in a sentence, and bills nothing", async () => {
    const before = await onHand("coffee", "juice");
    const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }], customerPhone: "12345" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("12345 is not a phone number - give the customer's 10 digits, with or without +91");
    expect(await onHand("coffee", "juice")).toBe(before);
  });

  it("refuses a name longer than 80 characters at the door", async () => {
    const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }], customerName: "x".repeat(81) });
    expect(r.statusCode).toBe(400);
  });
});
