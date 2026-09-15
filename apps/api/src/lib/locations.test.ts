import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { App } from "../app.js";
import { buildTestApp } from "../test/app.js";
import { truncateAll } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { authHeaders } from "../test/auth.js";
import { locations } from "../db/schema/index.js";

/**
 * A closed outlet, from every write that can name one. The outlet is closed straight on the row here -
 * the admin route that closes one refuses while stock, documents or staff remain, and each of these
 * writes has to be refused even so, because the row lock is what stops a sale that started a moment
 * before the close committed.
 */
let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "locations_lib" }); await app.ready(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });
afterAll(async () => { await app.close(); });

const send = async (userId: string, method: "POST" | "PATCH", url: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { ...(await authHeaders(app, userId)), "idempotency-key": randomUUID() }, payload });
const setOpen = (key: string, active: boolean) => app.db.update(locations).set({ active }).where(eq(locations.key, key));
const refusal = (r: { statusCode: number; body: string; json: () => { error: { message: string } } }) => {
  expect(r.statusCode, r.body).toBe(422);
  return r.json().error.message;
};
const CLOSED = "Refused - Snack Kiosk is closed";

describe("a closed outlet", () => {
  it("takes no sale", async () => {
    await setOpen("kiosk", false);
    expect(refusal(await send("u6", "POST", "/bills", { loc: "kiosk", tender: "Cash", lines: [{ it: "chips", qty: 1 }] }))).toBe(CLOSED);
  });
  it("has no bill voided until it is reopened", async () => {
    const sale = await send("u6", "POST", "/bills", { loc: "kiosk", tender: "Cash", lines: [{ it: "chips", qty: 1 }] });
    expect(sale.statusCode, sale.body).toBe(200);
    await setOpen("kiosk", false);
    const no = encodeURIComponent(sale.json().result.no);
    expect(refusal(await send("u2", "POST", `/bills/${no}/void`, { reason: "Rang up twice" })))
      .toBe(`${CLOSED}; reopen it before voiding its bills`);
    await setOpen("kiosk", true);
    expect((await send("u2", "POST", `/bills/${no}/void`, { reason: "Rang up twice" })).statusCode).toBe(200);
  });
  it("is neither end of a shop transfer", async () => {
    await setOpen("kiosk", false);
    expect(refusal(await send("u1", "POST", "/transfers", { from: "coffee", to: "kiosk", it: "chips", qty: 1 }))).toBe(CLOSED);
  });
  it("cannot be asked for stock", async () => {
    await setOpen("kiosk", false);
    expect(refusal(await send("u1", "POST", "/shop-asks", { to: "kiosk", it: "chips", qty: 1 }))).toBe(CLOSED);
  });
  it("orders nothing from the kitchen and is sent nothing from it", async () => {
    await setOpen("kiosk", false);
    expect(refusal(await send("u2", "POST", "/prod-orders", { from: "kiosk", lines: [{ it: "puff", qty: 1 }] }))).toBe(CLOSED);
    expect(refusal(await send("u4", "POST", "/distributions", { it: "puff", qty: 1, to: "kiosk" }))).toBe(CLOSED);
  });
  it("asks for no new product, has no stock adjusted, no product listed and nothing switched off", async () => {
    await setOpen("kiosk", false);
    expect(refusal(await send("u2", "POST", "/product-requests", { name: "Mango lassi", forLoc: "kiosk" }))).toBe(CLOSED);
    expect(refusal(await send("u2", "POST", "/adjustments", { loc: "kiosk", reason: "count", lines: [{ it: "chips", qty: 1 }] }))).toBe(CLOSED);
    expect(refusal(await send("u2", "POST", "/menus/kiosk/items", { it: "capp" }))).toBe(CLOSED);
    expect(refusal(await send("u2", "POST", "/availability/toggle", { loc: "kiosk", it: "chips" }))).toBe(CLOSED);
  });
  it("leaves every other outlet trading", async () => {
    await setOpen("kiosk", false);
    expect((await send("u1", "POST", "/bills", { loc: "coffee", tender: "Cash", lines: [{ it: "chips", qty: 1 }] })).statusCode).toBe(200);
  });
});

describe("a location key the master does not carry", () => {
  it("is a 404 the manager can read, not a crash", async () => {
    const r = await send("u2", "POST", "/menus/juice-bar/items", { it: "juice" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no location juice-bar.");
  });
});

describe("GET /stock", () => {
  it("carries an empty map for a location with nothing on its shelves", async () => {
    await app.db.insert(locations).values({ key: "juice-bar", name: "Juice Bar", code: "OT-JB", type: "Outlet", floor: "Ground", costCentre: "CC-JB", priceList: "A" });
    const r = await app.inject({ method: "GET", url: "/api/v1/stock", headers: await authHeaders(app, "u2") });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().stock["juice-bar"]).toEqual({});
  });
});
