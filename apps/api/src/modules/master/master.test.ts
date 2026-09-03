import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "master" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });
const get = async (url: string) => { const r = await app.inject({ method: "GET", url: `/api/v1${url}`, headers: await authHeaders(app, "u1") }); expect(r.statusCode).toBe(200); return r.json(); };

describe("master GETs", () => {
  it("items, locations, recipes, prices and menus equal the fixtures", async () => {
    expect(await get("/items")).toEqual(FX.IT);
    expect(await get("/locations")).toEqual(FX.LOC);
    expect(await get("/recipes")).toEqual(FX.RCP);
    expect(await get("/prices")).toEqual(FX.PL);
    expect(await get("/menus")).toEqual(FX.MENU);
  });
  it("are not location-scoped even for a counter operator", async () => {
    expect(Object.keys(await get("/menus")).sort()).toEqual(Object.keys(FX.MENU).sort());
  });
});
