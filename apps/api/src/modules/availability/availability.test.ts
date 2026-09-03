import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { availabilityOverrides } from "../../db/schema/index.js";
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

  it("refuses a manager toggling a location that is not an outlet", async () => {
    const r = await toggle(await hdr("u2"), { loc: "store", it: "chips" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Central Store is not an outlet");
  });

  it("refuses an unknown item key with a 404 instead of crashing", async () => {
    const r = await toggle(await hdr("u1"), { loc: "coffee", it: "totally-fake" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no item totally-fake.");
  });

  it("lets the kitchen in-charge switch a made product off, then on, at their own kitchen", async () => {
    const off = await toggle(await hdr("u4"), { loc: "kitchen", it: "puff" });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({
      result: { loc: "kitchen", it: "puff", off: true, reason: "switched off manually" },
      changed: ["ovr"],
      message: "Veg puffs switched off at Central Kitchen",
    });

    const on = await toggle(await hdr("u4"), { loc: "kitchen", it: "puff" });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({
      result: { loc: "kitchen", it: "puff", off: false },
      changed: ["ovr"],
      message: "Veg puffs switched on at Central Kitchen",
    });
  });

  it("refuses the kitchen in-charge toggling a counter", async () => {
    const r = await toggle(await hdr("u4"), { loc: "coffee", it: "juice" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe("You can only do this for your own kitchen.");
  });

  it("refuses a bought-in item at the kitchen: what it can switch off is what it can make", async () => {
    const r = await toggle(await hdr("u4"), { loc: "kitchen", it: "chips" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Salted chips 52g is not made at Central Kitchen");
  });

  it("hides the route entirely from a role that is neither counter, manager nor kitchen", async () => {
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

  it("two concurrent first-toggles for the same (loc, item) both succeed, deterministically", async () => {
    const [headersA, headersB] = await Promise.all([hdr("u1"), hdr("u1")]);
    const [a, b] = await Promise.all([
      toggle(headersA, { loc: "coffee", it: "bisc" }),
      toggle(headersB, { loc: "coffee", it: "bisc" }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().result.off).toBe(true);
    expect(b.json().result.off).toBe(true);

    const rows = await app.testDb!.db.select().from(availabilityOverrides)
      .where(and(eq(availabilityOverrides.loc, "coffee"), eq(availabilityOverrides.itemKey, "bisc")));
    expect(rows).toHaveLength(1);
  });
});
