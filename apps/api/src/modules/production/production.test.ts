import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll, warmPool } from "../../test/db.js";
import { postMoves } from "../../lib/ledger.js";
import { prodOrderLines, prodOrders, reservations, stockMoves } from "../../db/schema/index.js";
import type { InjectOptions } from "fastify";
import type { PordStatus } from "@rch/contract";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "production" }); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
/** A dispatch carries no body and a distribution does, so the payload is optional — spelled
 *  through an annotated `InjectOptions` because a spread hides which `inject` overload it is. */
const post = async (user: string, url: string, payload?: Record<string, unknown>) => {
  const opts: InjectOptions = { method: "POST", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) };
  return app.inject(opts);
};
const orders = async () => (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, "u4") })).json().pord;
const onHand = async (loc: string, it: string) =>
  (await app.inject({ method: "GET", url: "/api/v1/stock", headers: await authHeaders(app, "u2") })).json().stock[loc]?.[it] ?? 0;
/** The location's display name, read from the master the server itself serves. */
const locName = async (key: string) =>
  (await app.inject({ method: "GET", url: "/api/v1/locations", headers: await authHeaders(app, "u4") })).json()[key].n;
/** Bake enough of an item that the kitchen can cover a dispatch. */
const bake = (it: string, n: number) =>
  app.testDb!.db.transaction((tx) => postMoves(tx, [{ loc: "kitchen", it, qty: n, kind: "production_yield", refType: "test", refId: "bake" }]));
/**
 * The seed's two orders sit at New and Accepted, so a case about the transition table has to
 * write its own board. Ids are drawn above both the fixtures (PRD-2026-029/030) and the
 * sequence's start, and the counter never resets — `beforeEach` truncates, so no id repeats.
 */
let boards = 0;
const givenOrder = async (st: PordStatus, lines: { it: string; qty: number }[] = [{ it: "puff", qty: 5 }]): Promise<string> => {
  const id = `PRD-2026-9${String(++boards).padStart(2, "0")}`;
  await app.testDb!.db.insert(prodOrders).values({ id, fromLoc: "kiosk", byUser: "u4", status: st, note: "" });
  await app.testDb!.db.insert(prodOrderLines).values(lines.map((l, lineNo) => ({ orderId: id, lineNo, itemKey: l.it, qty: l.qty })));
  return id;
};

describe("POST /prod-orders/:id/dispatch", () => {
  it("puts every item on one ticket addressed to the ordering outlet, and reserves rather than moves", async () => {
    const [order] = (await orders()).filter((o: { st: string }) => o.st !== "Dispatched" && o.st !== "Declined");
    for (const l of order.lines) await bake(l.it, l.qty);
    const before = await onHand("kitchen", order.lines[0].it);
    const movesBefore = (await app.testDb!.db.select().from(stockMoves)).length;

    const r = await post("u4", `/prod-orders/${order.id}/dispatch`);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.ticket).toMatchObject({ req: order.id, from: "kitchen", to: order.from, st: "Issued" });
    expect(b.result.ticket.lines).toHaveLength(order.lines.length);
    expect(b.result.ticket.otp).toMatch(/^\d{6}$/);
    expect(b.result.order.st).toBe("Dispatched");
    expect(b.result.order.hist.at(-1)).toMatchObject({ s: "Dispatched", who: "Vinoth Prakash" });
    expect(b.changed).toEqual(["pord", "tkt", "rsv"]);
    expect(b.message).toBe(`${b.result.ticket.id} issued — all ${order.lines.length} item${order.lines.length === 1 ? "" : "s"} of ${order.id} reserved for ${await locName(order.from)}`);

    // Approval authorises; the scan moves.
    expect(await onHand("kitchen", order.lines[0].it)).toBe(before);
    expect((await app.testDb!.db.select().from(stockMoves)).length).toBe(movesBefore);
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, b.result.ticket.id));
    expect(held).toHaveLength(order.lines.length);
    expect(held.every((h) => h.loc === "kitchen" && h.releasedAt === null)).toBe(true);
  });

  it("dispatches nothing when one item is short, and names every item that is", async () => {
    const [order] = (await orders()).filter((o: { st: string; lines: unknown[] }) => o.st !== "Dispatched" && o.st !== "Declined" && o.lines.length > 1);
    await bake(order.lines[0].it, order.lines[0].qty);          // only the first is covered
    const movesBefore = (await app.testDb!.db.select().from(stockMoves)).length;

    const r = await post("u4", `/prod-orders/${order.id}/dispatch`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/^Nothing dispatched — the kitchen is short of /);
    expect((await app.testDb!.db.select().from(stockMoves)).length).toBe(movesBefore);
    expect(await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, "any"))).toEqual([]);
    expect((await orders()).find((o: { id: string }) => o.id === order.id).st).not.toBe("Dispatched");
  });

  it("refuses to raise a second ticket for an order already dispatched", async () => {
    const [order] = (await orders()).filter((o: { st: string }) => o.st !== "Dispatched" && o.st !== "Declined");
    for (const l of order.lines) await bake(l.it, l.qty);
    expect((await post("u4", `/prod-orders/${order.id}/dispatch`)).statusCode).toBe(200);

    const again = await post("u4", `/prod-orders/${order.id}/dispatch`);
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe(`${order.id} has already gone out — it is on one ticket to ${await locName(order.from)}`);
  });

  it("refuses a declined order in its own words", async () => {
    const id = await givenOrder("Declined");
    await bake("puff", 20);                                     // the shelf is not what says no
    const r = await post("u4", `/prod-orders/${id}/dispatch`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} was declined — it cannot be dispatched`);
  });

  // The other half of PROD_ORDER_TRANSITIONS: the kitchen sends when it is ready to, whatever
  // word the board is showing, so every open stage must go out — not just the two the seed has.
  it.each(["New", "Accepted", "In kitchen", "Ready"] as const)("dispatches an order sitting at %s", async (st) => {
    const id = await givenOrder(st);
    await bake("puff", 20);
    const r = await post("u4", `/prod-orders/${id}/dispatch`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.order.st).toBe("Dispatched");
  });

  it("dispatches exactly once when two screens press together", async () => {
    const [order] = (await orders()).filter((o: { st: string }) => o.st !== "Dispatched" && o.st !== "Declined");
    // Bake enough for both presses. Cover the order exactly and the second press is refused by
    // the all-or-nothing check instead of the guard, and the case passes with the row lock
    // taken out — it has to be the order's own status that says no, not the shelf.
    for (const l of order.lines) await bake(l.it, l.qty * 3);
    // `pg` hands a waiting caller an idle client rather than opening a second one, so without
    // this the two transactions run back to back and never race at all.
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([post("u4", `/prod-orders/${order.id}/dispatch`), post("u4", `/prod-orders/${order.id}/dispatch`)]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const [refused] = both.filter((r) => r.statusCode === 422);
    expect(refused.json().error.message).toBe(`${order.id} has already gone out — it is on one ticket to ${await locName(order.from)}`);
  });

  it("404s an order that is not there, and is absent for every other role", async () => {
    expect((await post("u4", "/prod-orders/PRD-2026-999/dispatch")).json().error.message).toBe("There is no production order PRD-2026-999.");
    for (const u of ["u1", "u2", "u3", "u5"]) expect((await post(u, "/prod-orders/PRD-2026-029/dispatch")).statusCode).toBe(404);
  });
});

describe("POST /distributions", () => {
  it("reserves at the kitchen and raises the ticket the outlet collects against", async () => {
    await bake("puff", 20);
    const before = await onHand("kitchen", "puff");

    const r = await post("u4", "/distributions", { it: "puff", qty: 5, to: "kiosk" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ req: "Direct issue", from: "kitchen", to: "kiosk", st: "Issued" });
    expect(b.result.lines).toEqual([{ it: "puff", qty: 5 }]);
    expect(b.changed).toEqual(["tkt", "rsv"]);
    expect(b.message).toBe(`${b.result.id} issued — 5 Veg puffs reserved for Snack Kiosk`);
    expect(await onHand("kitchen", "puff")).toBe(before);
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, b.result.id))).toHaveLength(0);
  });

  it("refuses a destination that does not list the product (M9)", async () => {
    await bake("puff", 20);
    const r = await post("u4", "/distributions", { it: "puff", qty: 5, to: "coffee" });   // coffee's menu has no puff
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Veg puffs is not listed at Coffee Shop — add it to that menu first");
  });

  it("refuses more than the kitchen has free", async () => {
    const free = await onHand("kitchen", "puff");
    const r = await post("u4", "/distributions", { it: "puff", qty: free + 1, to: "kiosk" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`Kitchen has only ${free} nos free to promise`);
  });

  it("counts what another ticket is already holding", async () => {
    const free = await onHand("kitchen", "puff");
    await given.ticket(app.testDb!.db, { from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: free }] });
    const r = await post("u4", "/distributions", { it: "puff", qty: 1, to: "kiosk" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Kitchen has only 0 nos free to promise");
  });

  it("refuses a quantity of nothing, 404s an unknown item, and is absent for a counter", async () => {
    expect((await post("u4", "/distributions", { it: "puff", qty: 0, to: "kiosk" })).json().error.message).toBe("Enter a quantity");
    expect((await post("u4", "/distributions", { it: "totally-fake", qty: 1, to: "kiosk" })).json().error.message).toBe("There is no item totally-fake.");
    expect((await post("u1", "/distributions", { it: "puff", qty: 1, to: "kiosk" })).statusCode).toBe(404);
  });
});
