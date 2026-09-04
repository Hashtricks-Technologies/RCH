import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { lockBalances, postMoves } from "../../lib/ledger.js";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll, warmPool } from "../../test/db.js";
import { readHistory } from "../../lib/history.js";
import { documentHistory, reservations, shopAsks, stockMoves, tickets } from "../../db/schema/index.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "tickets" }); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
// Two calls rather than one with a spread `payload`: an optional property spread into the
// options widens them past `InjectOptions` and TypeScript then picks inject's chainable
// overload, whose result has no `statusCode`.
const post = async (user: string, url: string, payload?: object) => {
  const headers = await hdr(user);
  const at = `/api/v1${url}`;
  return payload === undefined
    ? app.inject({ method: "POST", url: at, headers })
    : app.inject({ method: "POST", url: at, headers, payload });
};
const onHand = async (loc: string, it: string) => {
  const r = await app.inject({ method: "GET", url: "/api/v1/stock", headers: await authHeaders(app, "u2") });
  return r.json().stock[loc]?.[it] ?? 0;
};
/** On hand less what tickets are holding — the number a withdrawal actually gives back. The
 *  shelf itself never moves when a ticket is cancelled, so asserting `onHand` would prove
 *  nothing about the release. */
const freeAt = async (loc: string, it: string) => {
  const r = await app.inject({ method: "GET", url: "/api/v1/stock", headers: await authHeaders(app, "u2") });
  const j = r.json();
  return (j.stock[loc]?.[it] ?? 0) - (j.rsv[`${loc}:${it}`] ?? 0);
};
/** The seeded trail is stamped at the fixture's own times (08:05 … 08:34 today) and history
 *  reads back in time order, so a row appended by a test running earlier in the day is not the
 *  last one printed. What the case is about is that the row exists, once, signed by the person
 *  who made the movement. */
const trail = (req: { hist: { s: string; who: string }[] }, status: string) => req.hist.filter((h) => h.s === status);
/** Bake enough of an item that the kitchen can cover a dispatch. */
const bake = (it: string, n: number) =>
  app.testDb!.db.transaction((tx) => postMoves(tx, [{ loc: "kitchen", it, qty: n, kind: "production_yield", refType: "test", refId: "bake" }]));
const requestById = async (id: string) => {
  const r = await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u2") });
  return r.json().find((x: { id: string }) => x.id === id) as { st: string; hist: { s: string; who: string }[] };
};

describe("POST /tickets/:id/handover", () => {
  it("moves the stock out on the OTP, releases the hold, and closes nothing else", async () => {
    // TKT-0440: store -> coffee, 500 cups, Issued, otp 418327; its request REQ-2026-0909 is Ticket issued.
    const before = await onHand("store", "cup");
    const r = await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ id: "TKT-0440", st: "Collected", from: "store", to: "coffee" });
    expect(b.changed).toEqual(["tkt", "req", "rsv", "stock"]);
    expect(b.message).toBe("TKT-0440 handed over — stock is in transit to Coffee Shop");

    expect(await onHand("store", "cup")).toBe(before - 500);
    expect(await onHand("coffee", "cup")).toBe(180);          // in transit: owned by neither (M8)

    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, "TKT-0440"));
    expect(held).toHaveLength(1);
    expect(held.every((h) => h.releasedAt !== null)).toBe(true);
    const moves = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, "TKT-0440"));
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ loc: "store", itemKey: "cup", qty: -500, kind: "ticket_out" });

    const linked = await requestById("REQ-2026-0909");
    expect(linked.st).toBe("Collected");
    expect(trail(linked, "Collected")).toMatchObject([{ who: "Suresh Muthu" }]);
  });

  it("refuses a wrong OTP and moves nothing", async () => {
    const before = await onHand("store", "cup");
    const r = await post("u3", "/tickets/TKT-0440/handover", { otp: "000000" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("That OTP does not match TKT-0440. Ask the collector to read it again.");
    expect(await onHand("store", "cup")).toBe(before);
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, "TKT-0440"))).toHaveLength(0);
  });

  it("lets the store hand over without an OTP, and says so, and records the override", async () => {
    const r = await post("u3", "/tickets/TKT-0440/handover", {});
    expect(r.statusCode).toBe(200);
    expect(r.json().message).toBe("TKT-0440 handed over on a supervisor override — stock is in transit to Coffee Shop");
    const audit = await app.testDb!.db.select().from(documentHistory)
      .where(and(eq(documentHistory.docType, "ticket"), eq(documentHistory.docId, "TKT-0440")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ status: "Handed over — supervisor override", who: "Suresh Muthu" });
  });

  it("refuses the override to a counter", async () => {
    const id = await given.ticket(app.testDb!.db, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: "kiosk", lines: [{ it: "chips", qty: 2 }] });
    const r = await post("u1", `/tickets/${id}/handover`, {});
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Only the store or the kitchen may hand over without the OTP");
  });

  it("lets the kitchen hand its own ticket over (C2)", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: 5 }], otp: "123456" });
    const before = await onHand("kitchen", "puff");
    const r = await post("u4", `/tickets/${id}/handover`, { otp: "123456" });
    expect(r.statusCode).toBe(200);
    expect(await onHand("kitchen", "puff")).toBe(before - 5);
  });

  it("refuses a location that is not the one the ticket leaves from", async () => {
    const r = await post("u4", "/tickets/TKT-0440/handover", { otp: "418327" });   // kitchen, ticket is store's
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe("You can only do this for the location the ticket is issued from.");
  });

  it("refuses a second handover", async () => {
    await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    const again = await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe("TKT-0440 is already collected");
  });

  it("hands over exactly once when two windows press together", async () => {
    // Without this the second transaction waits for a socket instead of for the row lock, and
    // begins after the first has committed — the race never happens and the case passes with
    // `for update` deleted.
    await warmPool(app.testDb!, 4);
    const both = await Promise.all([post("u3", "/tickets/TKT-0440/handover", { otp: "418327" }), post("u3", "/tickets/TKT-0440/handover", { otp: "418327" })]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, "TKT-0440"))).toHaveLength(1);
  });

  it("404s a ticket that is not there", async () => {
    const r = await post("u3", "/tickets/TKT-0000/handover", { otp: "418327" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no ticket TKT-0000.");
  });
});

describe("POST /tickets/:id/receive", () => {
  it("books the stock in and closes the request behind it", async () => {
    await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    const r = await post("u1", "/tickets/TKT-0440/receive");
    expect(r.statusCode).toBe(200);
    expect(r.json().result.st).toBe("Received");
    expect(r.json().changed).toEqual(["tkt", "req", "stock"]);
    expect(r.json().message).toBe("Received at Coffee Shop — stock is on the shelf");
    expect(await onHand("coffee", "cup")).toBe(180 + 500);

    const moves = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, "TKT-0440"));
    expect(moves.map((m) => m.kind).sort()).toEqual(["ticket_in", "ticket_out"]);

    const linked = await requestById("REQ-2026-0909");
    expect(linked.st).toBe("Closed");
    expect(trail(linked, "Received")).toMatchObject([{ who: "Kavitha Raman" }]);
  });

  it("refuses to receive a ticket nobody has handed over yet", async () => {
    const r = await post("u1", "/tickets/TKT-0440/receive");
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("TKT-0440 is already issued");
  });

  it("refuses a counter receiving somebody else's delivery", async () => {
    await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    const r = await post("u6", "/tickets/TKT-0440/receive");     // kiosk, ticket goes to coffee
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe("You can only do this for the location the ticket is coming to.");
  });

  it("is absent for a buyer", async () => {
    expect((await post("u5", "/tickets/TKT-0440/receive")).statusCode).toBe(404);
  });

  it("receives exactly once when two shelves scan together", async () => {
    await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    await warmPool(app.testDb!, 4);
    const both = await Promise.all([post("u1", "/tickets/TKT-0440/receive"), post("u1", "/tickets/TKT-0440/receive")]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await onHand("coffee", "cup")).toBe(180 + 500);
  });

  it("queues behind a writer holding the request, instead of deadlocking with it", async () => {
    // Documents locked before balances, server-wide (lib/ledger.ts's header). A receipt that
    // took the shelf first and reached for its request afterwards would sit holding one lock
    // and waiting for the other while this transaction does the opposite — Postgres breaks that
    // by killing one of them, and the shelf that scanned in a delivery gets a 500. Taken in the
    // house order the receipt simply waits its turn. Fails with `linkedRequest` moved back
    // below `postMoves`: the pair deadlock and the receipt answers 500.
    await post("u3", "/tickets/TKT-0440/handover", { otp: "418327" });
    await warmPool(app.testDb!, 2);
    const rival = app.testDb!.db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from stock_requests where id = 'REQ-2026-0909' for update`);
      await new Promise((r) => setTimeout(r, 500));                    // the receipt gets its shelf lock in here
      await lockBalances(tx, [{ loc: "coffee", it: "cup" }]);
    });
    await new Promise((r) => setTimeout(r, 50));
    const [received] = await Promise.all([post("u1", "/tickets/TKT-0440/receive"), rival]);

    expect(received.statusCode, received.body).toBe(200);
    expect(await onHand("coffee", "cup")).toBe(180 + 500);
    expect((await requestById("REQ-2026-0909")).st).toBe("Closed");
  });
});

describe("POST /transfers", () => {
  it("reserves at the sending shop and raises the ticket the other collects against", async () => {
    const before = await onHand("coffee", "chips");
    const r = await post("u1", "/transfers", { from: "coffee", to: "kiosk", it: "chips", qty: 6 });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ req: "Shop transfer", from: "coffee", to: "kiosk", st: "Issued" });
    expect(b.result.lines).toEqual([{ it: "chips", qty: 6 }]);
    expect(b.changed).toEqual(["tkt", "rsv"]);
    expect(b.message).toBe(`${b.result.id} issued — 6 nos reserved at Coffee Shop for Snack Kiosk`);
    expect(await onHand("coffee", "chips")).toBe(before);     // reserved, not moved
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, b.result.id));
    expect(held[0]).toMatchObject({ loc: "coffee", itemKey: "chips", qty: 6, releasedAt: null });
  });

  it("refuses more than the shop has free to send", async () => {
    const r = await post("u1", "/transfers", { from: "coffee", to: "kiosk", it: "chips", qty: 99 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Coffee Shop has only 9 nos free to send");
  });

  it("refuses a quantity of nothing in the operator's words", async () => {
    const r = await post("u1", "/transfers", { from: "coffee", to: "kiosk", it: "chips", qty: 0 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Enter a quantity");
  });

  it("refuses anything that is not two different outlets", async () => {
    for (const body of [{ from: "coffee", to: "coffee", it: "chips", qty: 1 }, { from: "coffee", to: "store", it: "chips", qty: 1 }]) {
      const r = await post("u1", "/transfers", body);
      expect(r.statusCode).toBe(422);
      expect(r.json().error.message).toBe("A shop transfer runs between two different outlets");
    }
  });

  it("scopes a counter to their own shop but lets a manager move between any two", async () => {
    expect((await post("u1", "/transfers", { from: "kiosk", to: "coffee", it: "chips", qty: 1 })).statusCode).toBe(403);
    expect((await post("u2", "/transfers", { from: "kiosk", to: "coffee", it: "chips", qty: 1 })).statusCode).toBe(200);
  });

  it("promises the last of the shelf once when two transfers race for it", async () => {
    await warmPool(app.testDb!, 4);
    const both = await Promise.all([
      post("u1", "/transfers", { from: "coffee", to: "kiosk", it: "chips", qty: 8 }),
      post("u1", "/transfers", { from: "coffee", to: "rest", it: "chips", qty: 8 }),
    ]);
    // Coffee holds 9: one promise of 8 fits and the second cannot, so the same stock is never
    // promised twice. Unlike the two cases above, this one still passes with `lockBalances`
    // commented out — every ticket-creating write takes the `tkt` sequence's row lock first
    // (ids before balance rows), and that already serialises two transfers. The balance lock
    // stays because it is the guarantee that does not depend on the allocation happening to
    // come first; what this case pins is the outcome, not which lock produced it.
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });
});

describe("POST /tickets/:id/cancel", () => {
  it("gives the stock back and puts the request where the manager left it", async () => {
    // Approved in full, for whatever the store's shelf actually holds — issue-ticket re-checks
    // free-to-promise under the balance locks, so a number typed into the case rather than read
    // off the fixture is a case about the seed, not about the cancellation.
    const whole = await onHand("store", "milk");
    const req = await given.request(app.testDb!.db, {
      from: "coffee", lines: [{ it: "milk", qty: whole, appr: whole }], st: "Manager approved",
    });
    const issued = await post("u3", `/requests/${req}/issue-ticket`);
    const tkt = issued.json().result.ticket.id;
    const heldBefore = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, tkt));
    expect(heldBefore.every((h) => h.releasedAt === null)).toBe(true);
    const onShelf = await onHand("store", "milk");
    const movesBefore = (await app.testDb!.db.select().from(stockMoves)).length;

    const r = await post("u3", `/tickets/${tkt}/cancel`, { reason: "The counter closed before the collector came" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ id: tkt, st: "Cancelled" });
    expect(b.changed).toEqual(["tkt", "rsv", "req"]);
    expect(b.message).toBe(`${tkt} cancelled — ${req} is approved again and can be issued a new ticket`);

    // The hold is gone and the shelf never moved: nothing had left it.
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, tkt));
    expect(held.every((h) => h.releasedAt !== null)).toBe(true);
    expect(await onHand("store", "milk")).toBe(onShelf);
    expect((await app.testDb!.db.select().from(stockMoves)).length).toBe(movesBefore);

    // The reason is the only record there is, so it has to be findable.
    const hist = await readHistory(app.testDb!.db, "ticket", tkt);
    expect(hist.at(-1)).toMatchObject({ s: "Cancelled — The counter closed before the collector came", who: "Suresh Muthu" });
  });

  it("lets the issue desk raise a fresh ticket afterwards", async () => {
    const whole = await onHand("store", "milk");
    const req = await given.request(app.testDb!.db, {
      from: "coffee", lines: [{ it: "milk", qty: whole, appr: whole }], st: "Manager approved",
    });
    const first = (await post("u3", `/requests/${req}/issue-ticket`)).json().result.ticket.id;
    await post("u3", `/tickets/${first}/cancel`, { reason: "Wrong outlet" });

    const second = await post("u3", `/requests/${req}/issue-ticket`);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().result.ticket.id).not.toBe(first);
  });

  it("remembers that the approval was only partial", async () => {
    // Asked for more than the shelf carries and cut to what it does: the trim is the point.
    const whole = await onHand("store", "milk");
    const req = await given.request(app.testDb!.db, {
      from: "coffee", lines: [{ it: "milk", qty: whole + 8, appr: whole }], st: "Partially approved",
    });
    const tkt = (await post("u3", `/requests/${req}/issue-ticket`)).json().result.ticket.id;
    await post("u3", `/tickets/${tkt}/cancel`, { reason: "Collector never came" });

    const list = (await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u2") })).json();
    expect(list.find((r: { id: string }) => r.id === req)).toMatchObject({ st: "Partially approved", ticket: null });
  });

  it("puts a dispatched order back on the board", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "Ready", lines: [{ it: "puff", qty: 5 }] });
    await bake("puff", 5);
    const tkt = (await post("u4", `/prod-orders/${id}/dispatch`)).json().result.ticket.id;

    const r = await post("u4", `/tickets/${tkt}/cancel`, { reason: "Kiosk shut early" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().changed).toEqual(["tkt", "rsv", "pord"]);
    expect(r.json().message).toBe(`${tkt} cancelled — ${id} is back on the board, ready to dispatch again`);

    // `GET /prod-orders` is Task 3's and lands in the same wave; the snapshot has carried the
    // board since Phase 1, so the board is read from there and the assertion is the same one.
    const board = (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u4") })).json().pord;
    expect(board.find((o: { id: string }) => o.id === id).st).toBe("Ready");
    // And it can go out again.
    expect((await post("u4", `/prod-orders/${id}/dispatch`)).statusCode).toBe(200);
  });

  it("takes back a direct issue with nothing behind it", async () => {
    await bake("puff", 10);
    const tkt = (await post("u4", "/distributions", { it: "puff", qty: 5, to: "kiosk" })).json().result.id;
    const r = await post("u4", `/tickets/${tkt}/cancel`, { reason: "Sent to the wrong counter" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().changed).toEqual(["tkt", "rsv"]);
    expect(r.json().message).toBe(`${tkt} cancelled — the stock is free again at Central Kitchen`);
  });

  it("refuses a ticket already handed over, and one already cancelled", async () => {
    const tkt = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    const otp = (await app.testDb!.db.select().from(tickets).where(eq(tickets.id, tkt)))[0]!.otp;
    await post("u3", `/tickets/${tkt}/handover`, { otp });
    const gone = await post("u3", `/tickets/${tkt}/cancel`, { reason: "Changed our minds" });
    expect(gone.statusCode).toBe(422);
    expect(gone.json().error.message).toBe(`${tkt} has already been handed over — the stock is on its way to Coffee Shop`);

    const other = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    expect((await post("u3", `/tickets/${other}/cancel`, { reason: "Not needed" })).statusCode).toBe(200);
    const again = await post("u3", `/tickets/${other}/cancel`, { reason: "Not needed" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe(`${other} is already cancelled`);
  });

  it("refuses a cancellation with nothing said about it", async () => {
    const tkt = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    const r = await post("u3", `/tickets/${tkt}/cancel`, { reason: "   " });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Say why the ticket is being cancelled");
  });

  it("keeps each side to its own tickets", async () => {
    const store = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    const kitchen = await given.ticket(app.testDb!.db, { from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: 2 }] });
    // The kitchen may not cancel the store's ticket, nor the store the kitchen's.
    expect((await post("u4", `/tickets/${store}/cancel`, { reason: "no" })).statusCode).toBe(403);
    expect((await post("u3", `/tickets/${kitchen}/cancel`, { reason: "no" })).statusCode).toBe(403);
    // A counter has the door now — for its own outlet's tickets, which the store's is not, so
    // the role gate lets them knock and the location check refuses them. 403, not 404.
    expect((await post("u1", `/tickets/${store}/cancel`, { reason: "no" })).statusCode).toBe(403);
    // And for a manager and a buyer the door is not there at all.
    for (const u of ["u2", "u5"]) expect((await post(u, `/tickets/${store}/cancel`, { reason: "no" })).statusCode).toBe(404);
  });

  it("404s a ticket that is not there", async () => {
    expect((await post("u3", "/tickets/TKT-9999/cancel", { reason: "no" })).json().error.message).toBe("There is no ticket TKT-9999.");
  });

  it("cancels once when two windows press together", async () => {
    const tkt = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u3", `/tickets/${tkt}/cancel`, { reason: "Not needed" }),
      post("u3", `/tickets/${tkt}/cancel`, { reason: "Not needed" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, tkt));
    expect(held.every((h) => h.releasedAt !== null)).toBe(true);
  });

  it("either withdraws the ticket or hands it over, never both", async () => {
    // The two ends of one ticket racing each other. Both read `Issued` without the `for update`
    // in `ticketsRepo.head`, both pass their guard, and the ticket is withdrawn *and* collected:
    // the hold released twice over with `ticket_out` moves standing against a cancelled ticket.
    // Removing `.for("update")` from `head` is what this case is written to catch.
    const tkt = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    const otp = (await app.testDb!.db.select().from(tickets).where(eq(tickets.id, tkt)))[0]!.otp;
    await warmPool(app.testDb!, 2);
    const [cancelled, handed] = await Promise.all([
      post("u3", `/tickets/${tkt}/cancel`, { reason: "The counter closed" }),
      post("u3", `/tickets/${tkt}/handover`, { otp }),
    ]);
    expect([cancelled, handed].filter((r) => r.statusCode === 200)).toHaveLength(1);

    // Whichever won, the hold is gone; what tells the two apart is whether stock moved with it.
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, tkt));
    expect(held.every((h) => h.releasedAt !== null)).toBe(true);
    const moves = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, tkt));
    const st = (await app.testDb!.db.select().from(tickets).where(eq(tickets.id, tkt)))[0]!.status;
    if (cancelled.statusCode === 200) {
      expect(st).toBe("Cancelled");
      expect(moves).toHaveLength(0);                 // withdrawn: nothing left the store
    } else {
      expect(st).toBe("Collected");
      expect(moves).toMatchObject([{ loc: "store", itemKey: "milk", qty: -2, kind: "ticket_out" }]);
    }
  });
});

describe("a cancelled ticket is the end of it", () => {
  const cancelled = async () => {
    const tkt = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    expect((await post("u3", `/tickets/${tkt}/cancel`, { reason: "Counter closed early" })).statusCode).toBe(200);
    return tkt;
  };

  it("cannot be handed over, and says which word stopped it (M6)", async () => {
    const tkt = await cancelled();
    const otp = (await app.testDb!.db.select().from(tickets).where(eq(tickets.id, tkt)))[0]!.otp;
    const r = await post("u3", `/tickets/${tkt}/handover`, { otp });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${tkt} is already cancelled`);
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, tkt))).toHaveLength(0);
  });

  it("cannot be received either", async () => {
    const tkt = await cancelled();
    const r = await post("u1", `/tickets/${tkt}/receive`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${tkt} is already cancelled`);
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, tkt))).toHaveLength(0);
  });
});

describe("the counter's cancel door", () => {
  /** One shop asks, the other grants: the ticket the grant raises is the one under test. */
  const answerAsk = async (ask: string, grant: number) => {
    const r = await post("u1", `/shop-asks/${ask}/answer`, { grant });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().result.ticket.id as string;
  };

  it("lets the shop that granted a transfer withdraw it, and releases the hold", async () => {
    const id = await given.ticket(app.testDb!.db, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: "kiosk", lines: [{ it: "juice", qty: 3 }] });
    const before = await freeAt("coffee", "juice");

    const res = await post("u1", `/tickets/${id}/cancel`, { reason: "Kiosk found some of their own" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().message).toBe(`${id} cancelled — the stock is free again at Coffee Shop`);
    expect(await freeAt("coffee", "juice")).toBe(before + 3);
  });

  it("refuses a counter at the other end of it — the shop that is receiving cannot withdraw it", async () => {
    const id = await given.ticket(app.testDb!.db, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: "kiosk", lines: [{ it: "juice", qty: 3 }] });
    const res = await post("u6", `/tickets/${id}/cancel`, { reason: "no" });     // Deepa, at the kiosk
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("You can only do this for the location the ticket is issued from.");
  });

  it("puts a withdrawn grant's ask back on the desk it came from", async () => {
    const ask = await given.shopAsk(app.testDb!.db, { from: "kiosk", to: "coffee", it: "juice", qty: 5, st: "Asked" });
    const tkt = await answerAsk(ask, 4);

    const res = await post("u1", `/tickets/${tkt}/cancel`, { reason: "Sold out before they came" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changed).toContain("shopAsks");

    const [row] = await app.testDb!.db.select().from(shopAsks).where(eq(shopAsks.id, ask));
    expect(row!.status).toBe("Asked");
    expect(row!.grantedQty).toBeNull();
    expect(row!.ticketId).toBeNull();
  });

  it("lets the holding shop grant the reopened ask a second time", async () => {
    const ask = await given.shopAsk(app.testDb!.db, { from: "kiosk", to: "coffee", it: "juice", qty: 5, st: "Asked" });
    const first = await answerAsk(ask, 4);
    await post("u1", `/tickets/${first}/cancel`, { reason: "Sold out before they came" });
    // `Sent -> Asked` is the whole point of the reopen: without it `answer` refuses the second
    // grant on the transition, and the asking shop's request is stuck for good.
    const second = await answerAsk(ask, 2);
    expect(second).not.toBe(first);
  });

  it("still refuses the kitchen a shop's ticket", async () => {
    const id = await given.ticket(app.testDb!.db, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: "kiosk", lines: [{ it: "juice", qty: 3 }] });
    const res = await post("u4", `/tickets/${id}/cancel`, { reason: "no" });
    expect(res.statusCode).toBe(403);
  });

  it("reopens a withdrawn grant's ask exactly once when two cancellations race", async () => {
    const ask = await given.shopAsk(app.testDb!.db, { from: "kiosk", to: "coffee", it: "juice", qty: 5, st: "Asked" });
    const granted = await answerAsk(ask, 4);
    const freeBefore = await freeAt("coffee", "juice");
    // `pg` connects lazily: without this the second transaction waits ~5 ms for a socket and
    // begins after the first has committed, and the case passes with any lock removed.
    //
    // Which lock: the ticket's own `for update` in `ticketsRepo.head`, not `linkedShopAsk`'s.
    // Taken out, this case fails with two 200s and the hold released twice; `linkedShopAsk`'s
    // own lock can be taken out and this still passes, because one ask can only ever have one
    // live ticket against it, so the ticket lock has already serialised the pair by the time
    // the ask is read. That lock stays because a transition reads its own row — what this case
    // pins is the outcome, not which lock produced it, the same way the transfer race above does.
    await warmPool(app.testDb!, 2);

    const [a, b] = await Promise.allSettled([
      post("u1", `/tickets/${granted}/cancel`, { reason: "one" }),
      post("u1", `/tickets/${granted}/cancel`, { reason: "two" }),
    ]);
    const ok = [a, b].filter((r) => r.status === "fulfilled" && r.value.statusCode === 200);
    expect(ok).toHaveLength(1);

    const [row] = await app.testDb!.db.select().from(shopAsks).where(eq(shopAsks.id, ask));
    expect(row!.status).toBe("Asked");
    // And the hold came back once, not twice.
    expect(await freeAt("coffee", "juice")).toBe(freeBefore + 4);
  });
});

describe("the ticket's own trail", () => {
  it("records issue, handover and receipt, oldest first", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }], otp: "123456" });
    expect((await post("u3", `/tickets/${id}/handover`, { otp: "123456" })).statusCode).toBe(200);
    const received = await post("u1", `/tickets/${id}/receive`);
    expect(received.statusCode, received.body).toBe(200);
    expect(received.json().result.hist.map((h: { s: string }) => h.s)).toEqual(["Issued", "Handed over", "Received"]);
    expect(received.json().result.hist.map((h: { who: string }) => h.who)).toEqual(["Suresh Muthu", "Suresh Muthu", "Kavitha Raman"]);
  });

  it("names the supervisor override on the row rather than beside it", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    const r = await post("u3", `/tickets/${id}/handover`, {});
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.hist.map((h: { s: string }) => h.s)).toEqual(["Issued", "Handed over — supervisor override"]);
  });

  it("ends a withdrawn ticket with the reason it was withdrawn for", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "milk", qty: 2 }] });
    const r = await post("u3", `/tickets/${id}/cancel`, { reason: "Counter closed early" });
    expect(r.json().result.hist.map((h: { s: string }) => h.s)).toEqual(["Issued", "Cancelled — Counter closed early"]);
  });
});
