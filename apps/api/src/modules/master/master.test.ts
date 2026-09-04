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

/** What the readers that feed the UI still serve: the five locations an operator works at.
 *  `FX.LOC` gained `quarantine` with Phase 5's `StockLoc`, and `readers/master.ts` keeps
 *  filtering it out until the store's stock screen can show it. */
const WORKING_LOCS = Object.fromEntries(FX.ALL_LOCS.map((l) => [l, FX.LOC[l]]));

describe("master GETs", () => {
  it("items, locations, recipes, prices and menus equal the fixtures", async () => {
    expect(await get("/items")).toEqual(FX.IT);
    expect(await get("/locations")).toEqual(WORKING_LOCS);
    expect(await get("/recipes")).toEqual(FX.RCP);
    expect(await get("/prices")).toEqual(FX.PL);
    expect(await get("/menus")).toEqual(FX.MENU);
  });
  it("are not location-scoped even for a counter operator", async () => {
    expect(Object.keys(await get("/menus")).sort()).toEqual(Object.keys(FX.MENU).sort());
  });
});
