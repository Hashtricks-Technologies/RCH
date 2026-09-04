import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sum } from "drizzle-orm";
import { bestBeforeText } from "@rch/domain";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll, warmPool } from "../../test/db.js";
import { postMoves } from "../../lib/ledger.js";
import { batches as batchesTable, reservations, stockBalances, stockMoves, tickets } from "../../db/schema/index.js";
import type { InjectOptions } from "fastify";
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
/** The board `GET /batches` serves — `readBatches`'s own shape, for round-tripping a write. */
const getBatches = async () => (await app.inject({ method: "GET", url: "/api/v1/batches", headers: await authHeaders(app, "u4") })).json();
/** Bake enough of an item that the kitchen can cover a dispatch. */
const bake = (it: string, n: number) =>
  app.testDb!.db.transaction((tx) => postMoves(tx, [{ loc: "kitchen", it, qty: n, kind: "production_yield", refType: "test", refId: "bake" }]));
/**
 * The seed's two orders sit at New and Accepted, so a case about the transition table has to
 * write its own board. Ids are drawn above both the fixtures (PRD-2026-029/030) and the
 * sequence's start, and the counter never resets — `beforeEach` truncates, so no id repeats.
 */
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
    // The kitchen dispatching stands at the ticket's `from`, so the six digits are not in the
    // answer — the outlet collecting reads them off its own snapshot.
    expect(b.result.ticket.otp).toBe("");
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
    const id = await given.prodOrder(app.testDb!.db, { st: "Declined" });
    await bake("puff", 20);                                     // the shelf is not what says no
    const r = await post("u4", `/prod-orders/${id}/dispatch`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} was declined — it cannot be dispatched`);
  });

  // The other half of PROD_ORDER_TRANSITIONS: the kitchen sends when it is ready to, whatever
  // word the board is showing, so every open stage must go out — not just the two the seed has.
  it.each(["New", "Accepted", "In kitchen", "Ready"] as const)("dispatches an order sitting at %s", async (st) => {
    const id = await given.prodOrder(app.testDb!.db, { st });
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

  it("refuses the kitchen as a destination, and mints no ticket for it", async () => {
    // The tray is already in the kitchen. Sent to itself it would move nothing, and still take
    // a ticket number and hold the stock against a collection nobody is coming for. The prod
    // screen's own list of destinations leaves the kitchen out (`DESTS`); so does the server.
    await bake("puff", 20);
    const before = await app.testDb!.db.select().from(tickets);
    const r = await post("u4", "/distributions", { it: "puff", qty: 5, to: "kitchen" });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toMatchObject({
      code: "rule",
      message: "A tray cannot be distributed to the kitchen it came from — choose the store or an outlet",
    });
    expect(await app.testDb!.db.select().from(tickets)).toHaveLength(before.length);
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

/** Every batch row the database holds, newest first, for a suite that wants to count them. */
const allBatches = async () => app.testDb!.db.select().from(batchesTable);
/** A move ledger read, for the "nothing was written" half of every refusal. */
const moveCount = async () => (await app.testDb!.db.select().from(stockMoves)).length;

describe("POST /prod-orders/:id/status", () => {
  it("walks the board a stage at a time and signs each step", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "New" });

    const accepted = await post("u4", `/prod-orders/${id}/status`, { st: "Accepted" });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const b = accepted.json();
    expect(b.result).toMatchObject({ id, st: "Accepted" });
    expect(b.result.hist.at(-1)).toMatchObject({ s: "Accepted", who: "Vinoth Prakash" });
    expect(b.changed).toEqual(["pord"]);
    expect(b.message).toBe(`${id} — accepted`);

    expect((await post("u4", `/prod-orders/${id}/status`, { st: "In kitchen" })).json().message).toBe(`${id} — in kitchen`);
    expect((await post("u4", `/prod-orders/${id}/status`, { st: "Ready" })).json().message).toBe(`${id} — ready`);
    const board = (await orders()).find((o: { id: string }) => o.id === id);
    expect(board.st).toBe("Ready");
    expect(board.hist.map((h: { s: string }) => h.s)).toEqual(["Accepted", "In kitchen", "Ready"]);
  });

  it("refuses a stage skipped, and says which two it means", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "New" });
    const r = await post("u4", `/prod-orders/${id}/status`, { st: "Ready" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} is new — it cannot go straight to ready`);
    expect((await orders()).find((o: { id: string }) => o.id === id).st).toBe("New");
  });

  it("turns an order down, and will not take it back afterwards", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "New" });
    expect((await post("u4", `/prod-orders/${id}/status`, { st: "Declined" })).json().message).toBe(`${id} — declined`);
    const again = await post("u4", `/prod-orders/${id}/status`, { st: "Accepted" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe(`${id} is declined — it cannot go straight to accepted`);
  });

  it("sends nobody out through this door — dispatch mints a ticket and has its own", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "Ready" });
    const r = await post("u4", `/prod-orders/${id}/status`, { st: "Dispatched" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} goes out on a pick ticket — dispatch it from the order instead`);
    expect((await orders()).find((o: { id: string }) => o.id === id).st).toBe("Ready");
  });

  it("will not take a dispatched order back either — that edge belongs to cancelling the ticket", async () => {
    // The table has Dispatched -> Ready so a cancellation can put the order back (Task 1). This
    // door must not take it: doing so would leave a live ticket holding stock for an order the
    // board says is still cooking.
    const id = await given.prodOrder(app.testDb!.db, { st: "Dispatched" });
    const r = await post("u4", `/prod-orders/${id}/status`, { st: "Ready" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} has already gone out — cancel its ticket to bring it back onto the board`);
    expect((await orders()).find((o: { id: string }) => o.id === id).st).toBe("Dispatched");
  });

  it("accepts an order once when two screens press together", async () => {
    const id = await given.prodOrder(app.testDb!.db, { st: "New" });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u4", `/prod-orders/${id}/status`, { st: "Accepted" }),
      post("u4", `/prod-orders/${id}/status`, { st: "Accepted" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    const hist = (await orders()).find((o: { id: string }) => o.id === id).hist;
    expect(hist.filter((h: { s: string }) => h.s === "Accepted")).toHaveLength(1);
  });

  it("404s an order that is not there, and is absent for every other role", async () => {
    expect((await post("u4", "/prod-orders/PRD-2026-999/status", { st: "Accepted" })).json().error.message)
      .toBe("There is no production order PRD-2026-999.");
    const id = await given.prodOrder(app.testDb!.db, { st: "New" });
    for (const u of ["u1", "u2", "u3", "u5"]) {
      expect((await post(u, `/prod-orders/${id}/status`, { st: "Accepted" })).statusCode).toBe(404);
    }
  });
});

describe("POST /batches", () => {
  it("consumes the recipe for what was started and books only what came good (C1, UA-14)", async () => {
    const before = {
      maida: await onHand("kitchen", "maida"), fill: await onHand("kitchen", "fill"),
      oil: await onHand("kitchen", "oil"), box: await onHand("kitchen", "box"),
      puff: await onHand("kitchen", "puff"),
    };

    const r = await post("u4", "/batches", { it: "puff", started: 60, made: 58, note: "Oven tray dropped" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ it: "puff", qty: 60, made: 58, note: "Oven tray dropped" });
    expect(b.result.id).toMatch(/^BAT-\d{8}-\d{2}$/);
    expect(b.changed).toEqual(["batch", "stock"]);
    // The variance is the sentence's whole point; the best-before's exact wording is pinned by
    // the next case, against the instant the row actually carries.
    expect(b.message).toMatch(new RegExp(`^${b.result.id} — 58 of 60 Veg puffs yielded \\(-3\\.3%\\), best before \\d{2}:\\d{2}`));

    // Ingredients against what was started; only the yield onto the rack.
    expect(await onHand("kitchen", "maida")).toBeCloseTo(before.maida - 0.035 * 60, 3);
    expect(await onHand("kitchen", "fill")).toBeCloseTo(before.fill - 0.030 * 60, 3);
    expect(await onHand("kitchen", "oil")).toBeCloseTo(before.oil - 0.008 * 60, 3);
    expect(await onHand("kitchen", "box")).toBeCloseTo(before.box - 60, 3);
    expect(await onHand("kitchen", "puff")).toBeCloseTo(before.puff + 58, 3);

    // One document behind every movement: five moves, all pointing at this batch.
    const mine = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, b.result.id));
    expect(mine).toHaveLength(5);
    expect(mine.filter((m) => m.kind === "production_consume")).toHaveLength(4);
    expect(mine.filter((m) => m.kind === "production_yield")).toHaveLength(1);
    expect(mine.every((m) => m.refType === "batch" && m.loc === "kitchen")).toBe(true);
  });

  it("carries a blank note the same way the write responded and the board reads it back", async () => {
    // readBatches (modules/snapshot/readers/documents.ts) keeps `note: ""` rather than dropping
    // it — a null column has nothing to show, but a note typed as empty is still a note. The
    // write response has to agree, or a client sees the field appear out of nowhere on the next
    // GET /batches.
    const r = await post("u4", "/batches", { it: "puff", started: 10, note: "" });
    expect(r.statusCode, r.body).toBe(200);
    const written = r.json().result;
    expect(written).toHaveProperty("note", "");

    const fetched = (await getBatches()).find((b: { id: string }) => b.id === written.id);
    expect(fetched).toHaveProperty("note", "");
    expect(fetched).toEqual(written);
  });

  it("stamps the best-before from the item's shelf life, in the kitchen's own words", async () => {
    const r = await post("u4", "/batches", { it: "puff", started: 10 });
    const b = r.json();
    // Veg puffs keep 12 hours; the batch row carries the instant, the toast carries the wording.
    const row = (await allBatches()).find((x) => x.id === b.result.id)!;
    expect(new Date(row.bestBefore).getTime() - new Date(row.at).getTime()).toBe(12 * 3600_000);
    expect(b.message).toBe(`${b.result.id} — 10 Veg puffs made, best before ${bestBeforeText(new Date(row.bestBefore), new Date(row.at))}`);
  });

  it("keeps a product with no shelf life recorded for the working day", async () => {
    // The kitchen carries no tea leaf — it is the store that stocks it — so a make of masala
    // tea has to be given its ingredient before the shelf life is what the case is about.
    await bake("leaf", 1);
    const r = await post("u4", "/batches", { it: "chai", started: 4 });
    expect(r.statusCode, r.body).toBe(200);
    const row = (await allBatches()).find((x) => x.id === r.json().result.id)!;
    expect(new Date(row.bestBefore).getTime() - new Date(row.at).getTime()).toBe(8 * 3600_000);
  });

  it("treats an omitted yield as a full one", async () => {
    const before = await onHand("kitchen", "puff");
    const r = await post("u4", "/batches", { it: "puff", started: 10 });
    expect(r.json().result).toMatchObject({ qty: 10, made: 10 });
    expect(r.json().message).toMatch(/^BAT-\d{8}-\d{2} — 10 Veg puffs made, best before /);
    expect(await onHand("kitchen", "puff")).toBeCloseTo(before + 10, 3);
  });

  it("takes a whole tray lost: the ingredients go, nothing reaches the rack", async () => {
    const before = await onHand("kitchen", "puff");
    const maida = await onHand("kitchen", "maida");
    const r = await post("u4", "/batches", { it: "puff", started: 10, made: 0, note: "Oven failed mid-bake" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result).toMatchObject({ qty: 10, made: 0 });
    expect(await onHand("kitchen", "puff")).toBeCloseTo(before, 3);
    expect(await onHand("kitchen", "maida")).toBeCloseTo(maida - 0.035 * 10, 3);
    // A yield of nothing is not a movement; the batch row is what records it.
    const mine = await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, r.json().result.id));
    expect(mine.filter((m) => m.kind === "production_yield")).toHaveLength(0);
  });

  it("leaves no phantom shelf line when a total loss is of something the kitchen never carried", async () => {
    // The kitchen carries no `chai` — it has a recipe but has never been made here. A batch
    // that yields nothing must not lock, and so must not create, its balance row: a zero row
    // reads as "this location carries the line" on every stock screen (M12, spec §16).
    await bake("leaf", 1);
    expect((await app.testDb!.db.select().from(stockBalances)
      .where(and(eq(stockBalances.loc, "kitchen"), eq(stockBalances.itemKey, "chai")))))
      .toHaveLength(0);

    const r = await post("u4", "/batches", { it: "chai", started: 4, made: 0, note: "Urn boiled dry" });
    expect(r.statusCode, r.body).toBe(200);

    expect((await app.testDb!.db.select().from(stockBalances)
      .where(and(eq(stockBalances.loc, "kitchen"), eq(stockBalances.itemKey, "chai")))))
      .toHaveLength(0);
  });

  it("refuses a yield greater than the quantity started, and writes nothing at all", async () => {
    const before = await onHand("kitchen", "puff");
    const count = await moveCount();
    const r = await post("u4", "/batches", { it: "puff", started: 10, made: 25 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Yield cannot exceed the 10 started");
    expect(await onHand("kitchen", "puff")).toBe(before);
    expect(await moveCount()).toBe(count);
    expect(await allBatches()).toHaveLength(1);   // the seeded one, and no more
  });

  it("refuses a make of nothing", async () => {
    expect((await post("u4", "/batches", { it: "puff", started: 0 })).json().error.message).toBe("Enter a quantity to make");
  });

  it("refuses a product the kitchen has switched off", async () => {
    await post("u4", "/availability/toggle", { loc: "kitchen", it: "puff" });
    const r = await post("u4", "/batches", { it: "puff", started: 10 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Veg puffs is switched off in the kitchen");
  });

  it("refuses a product with nothing written down to make it by", async () => {
    const r = await post("u4", "/batches", { it: "water", started: 10 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Mineral water 1L has no recipe — it cannot be produced");
  });

  it("names the ingredient that ran out, and moves nothing (C1)", async () => {
    const count = await moveCount();
    const fill = await onHand("kitchen", "fill");
    // 101 puffs need 3.03 kg of filling; the kitchen holds 3.
    const r = await post("u4", "/batches", { it: "puff", started: 101 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`Kitchen is short of Veg filling mix — ${fill.toFixed(3)} kg left`);
    expect(await moveCount()).toBe(count);
  });

  it("counts what another ticket is already holding, not merely what is on the shelf", async () => {
    const fill = await onHand("kitchen", "fill");
    await given.ticket(app.testDb!.db, { from: "kitchen", to: "kiosk", lines: [{ it: "fill", qty: fill }] });
    const r = await post("u4", "/batches", { it: "puff", started: 1 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Kitchen is short of Veg filling mix — 0.000 kg left");
  });

  it("makes one of two races and refuses the other, leaving no ingredient below zero", async () => {
    // The kitchen's filling covers 100 puffs. Two makes of 60 cannot both be right.
    // What this does not pin: the `batch` sequence row serialises minting, so both calls queue
    // there before either reads a balance — the balance lock itself is proven by the
    // neighbouring batch-vs-distribution case below, which races a make against a distribution
    // instead of a make against a make.
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u4", "/batches", { it: "puff", started: 60 }),
      post("u4", "/batches", { it: "puff", started: 60 }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    expect(await onHand("kitchen", "fill")).toBeGreaterThanOrEqual(0);
    expect(await allBatches()).toHaveLength(2);   // the seeded one plus the winner
  });

  it("will not promise the same filling to a tray and a tray-load of puffs at once", async () => {
    // The case above races two makes, and two makes cannot reach the shelf together whatever
    // the balance locks do: both take the `batch` sequence row first, so the loser is still
    // waiting for the winner's commit when it reads a balance. A distribution takes the ticket
    // sequence instead, so it and a make arrive at the kitchen's filling at the same moment —
    // and `lockBalances` (with the post-lock re-read behind it) is the only thing between them.
    const fill = await onHand("kitchen", "fill");
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u4", "/batches", { it: "puff", started: 60 }),               // 1.8 kg of the 3
      post("u4", "/distributions", { it: "fill", qty: fill, to: "store" }),  // and all 3 of it
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    // Whichever won, what is left on the shelf still covers what is still promised off it.
    const [held] = await app.testDb!.db.select({ qty: sum(reservations.qty) }).from(reservations)
      .where(and(eq(reservations.loc, "kitchen"), eq(reservations.itemKey, "fill"), isNull(reservations.releasedAt)));
    expect(await onHand("kitchen", "fill")).toBeGreaterThanOrEqual(Number(held?.qty ?? 0));
  });

  it("404s an unknown item, and is absent for every other role", async () => {
    expect((await post("u4", "/batches", { it: "totally-fake", started: 1 })).json().error.message).toBe("There is no item totally-fake.");
    for (const u of ["u1", "u2", "u3", "u5"]) expect((await post(u, "/batches", { it: "puff", started: 1 })).statusCode).toBe(404);
  });
});
