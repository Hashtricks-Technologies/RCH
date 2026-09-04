import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { lockBalances } from "../../lib/ledger.js";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll, warmPool } from "../../test/db.js";
import { documentHistory, reservations, stockMoves } from "../../db/schema/index.js";
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
/** The seeded trail is stamped at the fixture's own times (08:05 … 08:34 today) and history
 *  reads back in time order, so a row appended by a test running earlier in the day is not the
 *  last one printed. What the case is about is that the row exists, once, signed by the person
 *  who made the movement. */
const trail = (req: { hist: { s: string; who: string }[] }, status: string) => req.hist.filter((h) => h.s === status);
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
