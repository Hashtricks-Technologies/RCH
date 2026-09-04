import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll } from "../../test/db.js";
import { reservations, stockMoves } from "../../db/schema/index.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "shopasks" }); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) });

describe("POST /shop-asks", () => {
  it("asks the other shop directly, not the manager", async () => {
    const r = await post("u1", "/shop-asks", { to: "kiosk", it: "water", qty: 24, note: "Ran dry over the morning clinic." });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ id: "ASK-063", from: "coffee", to: "kiosk", it: "water", qty: 24, st: "Asked", by: "Kavitha Raman", note: "Ran dry over the morning clinic." });
    expect(b.changed).toEqual(["shopAsks"]);
    expect(b.message).toBe("ASK-063 sent to Snack Kiosk — they decide, not the manager");
  });

  it("refuses the asker's own shop, a location that is not a shop, and no quantity", async () => {
    expect((await post("u1", "/shop-asks", { to: "coffee", it: "water", qty: 1 })).json().error.message).toBe("Pick a different shop");
    expect((await post("u1", "/shop-asks", { to: "store", it: "water", qty: 1 })).json().error.message).toBe("Only another shop can be asked directly");
    expect((await post("u1", "/shop-asks", { to: "kiosk", it: "water", qty: 0 })).json().error.message).toBe("Enter a quantity");
  });

  it("404s an item the master does not have, and is absent for a manager", async () => {
    expect((await post("u1", "/shop-asks", { to: "kiosk", it: "totally-fake", qty: 1 })).json().error.message).toBe("There is no item totally-fake.");
    expect((await post("u2", "/shop-asks", { to: "kiosk", it: "water", qty: 1 })).statusCode).toBe(404);
  });
});

describe("POST /shop-asks/:id/answer", () => {
  it("grants it, reserves at the shop that holds it, and raises the ticket the asker collects", async () => {
    // ASK-0060: kiosk asks coffee for 6 chips. Coffee holds 9.
    const r = await post("u1", "/shop-asks/ASK-0060/answer", { grant: 6 });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result.ask).toMatchObject({ id: "ASK-0060", st: "Sent", grant: 6, ticket: b.result.ticket.id });
    expect(b.result.ticket).toMatchObject({ req: "ASK-0060", from: "coffee", to: "kiosk", st: "Issued" });
    expect(b.result.ticket.lines).toEqual([{ it: "chips", qty: 6 }]);
    expect(b.changed).toEqual(["shopAsks", "tkt", "rsv"]);
    expect(b.message).toBe(`ASK-0060 granted — ${b.result.ticket.id} issued for 6 nos to Snack Kiosk`);

    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, b.result.ticket.id));
    expect(held[0]).toMatchObject({ loc: "coffee", itemKey: "chips", qty: 6, releasedAt: null });
    expect(await app.testDb!.db.select().from(stockMoves).where(eq(stockMoves.refId, b.result.ticket.id))).toHaveLength(0);
  });

  it("refuses more than was asked for rather than quietly trimming it", async () => {
    const r = await post("u1", "/shop-asks/ASK-0060/answer", { grant: 99 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Snack Kiosk asked for 6 nos — grant that or less");
    expect((await app.inject({ method: "GET", url: "/api/v1/shop-asks", headers: await authHeaders(app, "u1") })).json()
      .find((a: { id: string }) => a.id === "ASK-0060").st).toBe("Asked");
  });

  it("grants less than was asked when that is all the shop can spare", async () => {
    const r = await post("u1", "/shop-asks/ASK-0060/answer", { grant: 4 });
    expect(r.statusCode).toBe(200);
    expect(r.json().result.ask.grant).toBe(4);
    expect(r.json().result.ticket.lines).toEqual([{ it: "chips", qty: 4 }]);
  });

  it("refuses a grant of nothing, and one the shelf cannot cover", async () => {
    expect((await post("u1", "/shop-asks/ASK-0060/answer", { grant: 0 })).json().error.message).toBe("Grant a quantity, or decline the ask");
    const big = await given.shopAsk(app.testDb!.db, { from: "kiosk", to: "coffee", it: "chips", qty: 50, by: "u6" });
    const r = await post("u1", `/shop-asks/${big}/answer`, { grant: 50 });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Coffee Shop has only 9 nos free to send");
  });

  it("refuses the shop that asked, and refuses answering twice", async () => {
    expect((await post("u6", "/shop-asks/ASK-0060/answer", { grant: 6 })).statusCode).toBe(403);   // u6 asked
    await post("u1", "/shop-asks/ASK-0060/answer", { grant: 6 });
    const again = await post("u1", "/shop-asks/ASK-0060/answer", { grant: 1 });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe("ASK-0060 is already sent");
  });

  it("404s an ask that is not there", async () => {
    const r = await post("u1", "/shop-asks/ASK-9999/answer", { grant: 1 });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no shop ask ASK-9999.");
  });
});

describe("POST /shop-asks/:id/decline", () => {
  it("needs a reason the other shop can read", async () => {
    const r = await post("u1", "/shop-asks/ASK-0060/decline", { reason: "  " });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Give a reason — the other shop sees it");
  });

  it("declines with the reason, and issues no ticket", async () => {
    const r = await post("u1", "/shop-asks/ASK-0060/decline", { reason: "We are short ourselves" });
    expect(r.json().result).toMatchObject({ id: "ASK-0060", st: "Declined", reason: "We are short ourselves" });
    expect(r.json().changed).toEqual(["shopAsks"]);
    expect(r.json().message).toBe("ASK-0060 declined");
    const answer = await post("u1", "/shop-asks/ASK-0060/answer", { grant: 6 });
    expect(answer.statusCode).toBe(422);
    expect(answer.json().error.message).toBe("ASK-0060 is already declined");
  });
});
