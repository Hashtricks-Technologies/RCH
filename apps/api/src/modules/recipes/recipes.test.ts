import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { InjectOptions } from "fastify";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { EVENTS_CHANNEL_PREFIX } from "../../lib/events.js";
import { readHistory } from "../../lib/history.js";
import type { App } from "../../app.js";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";

let app: App;
let listener: Client;
let heard: string[] = [];

beforeAll(async () => {
  app = await buildTestApp({ schema: "recipes" });
  await seedTestDb(app.testDb!.db);
  await app.ready();
  listener = new Client({ connectionString: BASE, options: `-c search_path=${app.testDb!.schemaName},public` });
  await listener.connect();
  listener.on("notification", (m) => { if (m.payload) heard.push(m.payload); });
  await listener.query(`listen "${EVENTS_CHANNEL_PREFIX}${app.testDb!.schemaName}"`);
});
afterAll(async () => { await listener.end(); await app.close(); });

const send = async (method: InjectOptions["method"], user: string, url: string, payload?: Record<string, unknown>) =>
  app.inject({
    method, url: `/api/v1${url}`,
    headers: { ...(await authHeaders(app, user)), "idempotency-key": randomUUID() },
    ...(payload === undefined ? {} : { payload }),
  });
const put = (user: string, it: string, payload: Record<string, unknown>) => send("PUT", user, `/recipes/${it}`, payload);
const recipes = async () => (await app.inject({ method: "GET", url: "/api/v1/recipes", headers: await authHeaders(app, "u4") })).json();
const settle = () => new Promise((r) => setTimeout(r, 150));

// u4 is the kitchen in-charge, u2 the outlet manager - the two roles that keep recipes.
describe("PUT /recipes/:it", () => {
  it("replaces a recipe whole, costs it, and names the item's own trail", async () => {
    heard = [];
    const r = await put("u4", "capp", { ov: 10, lines: [{ it: "milk", qty: 0.2 }, { it: "beans", qty: 0.015 }, { it: "cup", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(200);
    // milk 0.2 × 52 + beans 0.015 × 640 + cup 1 × 0.62 = 10.4 + 9.6 + 0.62 = 20.62; +10% = 22.682
    expect(r.json().message).toBe("Cappuccino's recipe changed - 3 ingredients, ₹22.68 a unit");
    expect(r.json().changed).toEqual(["recipes"]);
    expect(r.json().result).toEqual({ key: "capp", recipe: { ov: 10, l: [["milk", 0.2], ["beans", 0.015], ["cup", 1]] } });

    // The sugar line the seeded recipe carried is gone, not left behind beside the new three.
    expect((await recipes()).capp).toEqual({ ov: 10, l: [["milk", 0.2], ["beans", 0.015], ["cup", 1]] });

    const hist = await readHistory(app.testDb!.db, "item", "capp");
    expect(hist.at(-1)).toMatchObject({ s: "Recipe changed", who: "Vinoth Prakash" });

    await settle();
    expect(heard.some((p) => JSON.parse(p).collections.includes("recipes"))).toBe(true);
  });

  it("gives a new made-to-order item its first recipe, which the till then sells by", async () => {
    // A product the store adds carries no recipe at all - the case a clean hospital starts in.
    // `POST /items` wants a standard cost above zero even for a made item; once a recipe exists it
    // is the recipe, not this figure, that `costOf` reads.
    const made = await send("POST", "u3", "/items", { name: "Filter coffee", type: "MTO", cost: 10, loc: "store" });
    expect(made.statusCode, made.body).toBe(200);
    const key = made.json().result.key as string;

    const r = await put("u2", key, { ov: 12, lines: [{ it: "milk", qty: 0.1 }, { it: "beans", qty: 0.01 }] });
    expect(r.statusCode, r.body).toBe(200);
    // (0.1 × 52 + 0.01 × 640) × 1.12 = (5.2 + 6.4) × 1.12 = 12.992
    expect(r.json().message).toBe("Filter coffee's recipe saved - 2 ingredients, ₹12.99 a unit");
    expect((await readHistory(app.testDb!.db, "item", key)).at(-1)).toMatchObject({ s: "Recipe added", who: "Ramesh Kumar" });
  });

  it("refuses in the rule's own words and changes nothing", async () => {
    const before = (await recipes()).chai;
    const cases: [string, Record<string, unknown>, string][] = [
      ["milk", { ov: 12, lines: [{ it: "sugar", qty: 0.01 }] }, "Milk 1L (toned) is a raw material - only a finished good or a made-to-order item has a recipe"],
      ["chai", { ov: 150, lines: [{ it: "milk", qty: 0.1 }] }, "Overhead must be between 0% and 100%"],
      ["chai", { ov: 12, lines: [] }, "Add at least one ingredient to Masala tea's recipe"],
      ["chai", { ov: 12, lines: [{ it: "chai", qty: 1 }] }, "Masala tea cannot be an ingredient of itself"],
      ["chai", { ov: 12, lines: [{ it: "ghost", qty: 1 }] }, "There is no item ghost to use as an ingredient."],
      ["chai", { ov: 12, lines: [{ it: "capp", qty: 1 }] }, "Cappuccino is made to order at the counter - it has no stock for a recipe to draw on"],
      ["chai", { ov: 12, lines: [{ it: "milk", qty: 0.1 }, { it: "milk", qty: 0.1 }] }, "Milk 1L (toned) is on the recipe twice - put it on one line"],
      ["chai", { ov: 12, lines: [{ it: "milk", qty: 0 }] }, "Enter a quantity of Milk 1L (toned) above zero"],
    ];
    for (const [it, body, sentence] of cases) {
      const r = await put("u4", it, body);
      expect(r.statusCode, `${it} ${JSON.stringify(body)}`).toBe(422);
      expect(r.json().error.message).toBe(sentence);
    }
    expect((await recipes()).chai).toEqual(before);
  });

  it("answers an item that does not exist with a 404, and a retired one with a sentence", async () => {
    const missing = await put("u4", "ghost", { ov: 12, lines: [{ it: "milk", qty: 1 }] });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe("There is no item ghost.");

    const made = await send("POST", "u3", "/items", { name: "Seasonal soup", type: "FG", cost: 30, loc: "store" });
    const key = made.json().result.key as string;
    expect((await send("PATCH", "u3", `/items/${key}`, { active: false })).statusCode).toBe(200);
    const retired = await put("u4", key, { ov: 12, lines: [{ it: "milk", qty: 1 }] });
    expect(retired.statusCode).toBe(422);
    expect(retired.json().error.message).toBe("Seasonal soup is retired - restore it before changing its recipe");
  });

  it("is the kitchen's and the manager's door only", async () => {
    for (const u of ["u1", "u3", "u5"]) {
      const r = await put(u, "chai", { ov: 12, lines: [{ it: "milk", qty: 0.1 }] });
      expect(r.statusCode, u).toBe(404);
    }
  });
});
