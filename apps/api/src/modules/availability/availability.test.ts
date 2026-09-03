import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "availability" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const toggle = (headers: Record<string, string>, payload: { loc: string; it: string }) =>
  app.inject({ method: "POST", url: "/api/v1/availability/toggle", headers, payload });

describe("POST /availability/toggle", () => {
  it("a counter switches an item off, then on, at their own counter", async () => {
    const off = await toggle(await hdr("u1"), { loc: "coffee", it: "juice" });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({
      result: { loc: "coffee", it: "juice", off: true, reason: "switched off manually" },
      changed: ["ovr"],
      message: "Real Juice 200ml switched off at Coffee Shop",
    });

    const on = await toggle(await hdr("u1"), { loc: "coffee", it: "juice" });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({
      result: { loc: "coffee", it: "juice", off: false },
      changed: ["ovr"],
      message: "Real Juice 200ml switched on at Coffee Shop",
    });
  });

  it("refuses a counter toggling a counter that is not their own", async () => {
    const r = await toggle(await hdr("u1"), { loc: "kiosk", it: "chips" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe("You can only do this for your own counter.");
  });

  it("lets a manager toggle at any outlet, not only their own", async () => {
    const r = await toggle(await hdr("u2"), { loc: "kiosk", it: "chips" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      result: { loc: "kiosk", it: "chips", off: true, reason: "switched off manually" },
      changed: ["ovr"],
      message: "Salted chips 52g switched off at Snack Kiosk",
    });
  });

  it("hides the route entirely from a role that is not counter or manager", async () => {
    const r = await toggle(await hdr("u3"), { loc: "store", it: "chips" });
    expect(r.statusCode).toBe(404);
  });

  it("refuses an item that is not listed at the location", async () => {
    const r = await toggle(await hdr("u1"), { loc: "coffee", it: "puff" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Veg puffs is not listed at Coffee Shop");
  });

  it("shows the override on GET /stock", async () => {
    const off = await toggle(await hdr("u1"), { loc: "coffee", it: "water" });
    expect(off.statusCode).toBe(200);

    const stock = await app.inject({ method: "GET", url: "/api/v1/stock", headers: await authHeaders(app, "u1") });
    expect(stock.statusCode).toBe(200);
    expect(stock.json().ovr["coffee:water"]).toBe("switched off manually");
  });
});
