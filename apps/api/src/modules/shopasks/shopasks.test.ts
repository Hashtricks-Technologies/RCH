import { afterAll, beforeAll, expect, it } from "vitest";
import { buildTestApp } from "../../test/app.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "shopasks" }); await app.ready(); });
afterAll(async () => { await app.close(); });

it("registers", () => { expect(app.hasPlugin("module:shopasks")).toBe(true); });
