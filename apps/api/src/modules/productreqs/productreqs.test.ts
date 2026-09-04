import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll } from "../../test/db.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "productreqs" }); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: await hdr(user), ...(payload === undefined ? {} : { payload }) });

describe("POST /product-requests", () => {
  it("sends a shop's ask to the central store", async () => {
    const b = (await post("u2", "/product-requests", { name: "Sugar-free lemon iced tea 250ml", why: "Diabetic attenders ask daily", forLoc: "coffee" })).json();
    expect(b.result).toMatchObject({ name: "Sugar-free lemon iced tea 250ml", forLoc: "coffee", st: "Requested", by: "Ramesh Kumar" });
    expect(b.result.id).toMatch(/^NPR-00\d+$/);
    expect(b.changed).toEqual(["productReqs"]);
    expect(b.message).toBe(`${b.result.id} sent to the central store — they add it to the master`);
  });

  it("wants a name, and is open to a counter as well as a manager", async () => {
    expect((await post("u2", "/product-requests", { name: "  ", forLoc: "coffee" })).json().error.message)
      .toBe("Name the product you want added");
    expect((await post("u1", "/product-requests", { name: "Something", forLoc: "coffee" })).statusCode).toBe(200);
    for (const u of ["u3", "u4", "u5"]) {
      expect((await post(u, "/product-requests", { name: "Something", forLoc: "coffee" })).statusCode).toBe(404);
    }
  });
});

describe("POST /product-requests/:id/answer", () => {
  it("links a request to the item it became", async () => {
    const id = await given.productRequest(app.testDb!.db, { name: "Iced lemon tea 300ml" });
    const b = (await post("u5", `/product-requests/${id}/answer`, { st: "Created", note: "Added as MR-3005", itemKey: "bisc" })).json();
    expect(b.result).toMatchObject({ st: "Created", note: "Added as MR-3005", itemKey: "bisc" });
    expect(b.changed).toEqual(["productReqs"]);
    expect(b.message).toBe(`${id} — product created on the master`);
  });

  it("declines with a note", async () => {
    const id = await given.productRequest(app.testDb!.db, { name: "Unobtainable 1kg" });
    const b = (await post("u3", `/product-requests/${id}/answer`, { st: "Declined", note: "Vendor cannot supply reliably" })).json();
    expect(b.result).toMatchObject({ st: "Declined", note: "Vendor cannot supply reliably" });
    expect(b.message).toBe(`${id} declined`);
  });

  it("will not mark one created without the item it became", async () => {
    const id = await given.productRequest(app.testDb!.db, { name: "Ghost 1kg" });
    expect((await post("u5", `/product-requests/${id}/answer`, { st: "Created", note: "" })).json().error.message)
      .toBe("Pick the catalogue item this request became");
    expect((await post("u5", `/product-requests/${id}/answer`, { st: "Created", note: "", itemKey: "nope" })).json().error.message)
      .toBe("There is no item nope.");
  });

  it("answers once, 404s an unknown id, and is absent for a counter or the kitchen", async () => {
    const id = await given.productRequest(app.testDb!.db, { name: "Once only 1kg" });
    await post("u3", `/product-requests/${id}/answer`, { st: "Declined", note: "no" });
    expect((await post("u3", `/product-requests/${id}/answer`, { st: "Declined", note: "no" })).json().error.message)
      .toBe(`${id} has already been answered`);
    expect((await post("u3", "/product-requests/NPR-7777/answer", { st: "Declined", note: "no" })).json().error.message)
      .toBe("There is no product request NPR-7777.");
    for (const u of ["u1", "u2", "u4"]) {
      expect((await post(u, `/product-requests/${id}/answer`, { st: "Declined", note: "no" })).statusCode).toBe(404);
    }
  });
});
