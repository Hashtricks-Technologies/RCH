import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { withTestSchema, type TestDb } from "../test/db.js";
import { EVENTS_CHANNEL_PREFIX, emitChanged } from "./events.js";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";

let t: TestDb;
let listener: Client;
let heard: string[] = [];

beforeAll(async () => {
  t = await withTestSchema("events");
  listener = new Client({ connectionString: BASE, options: `-c search_path=${t.schemaName},public` });
  await listener.connect();
  listener.on("notification", (m) => { if (m.payload) heard.push(m.payload); });
  await listener.query(`listen "${EVENTS_CHANNEL_PREFIX}${t.schemaName}"`);
});
afterAll(async () => { await listener.end(); await t.close(); });

/** NOTIFY is delivered asynchronously; give the listener socket a turn. */
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("emitChanged", () => {
  it("announces a committed write once, with the collections de-duplicated", async () => {
    heard = [];
    await t.db.transaction(async (tx) => { await emitChanged(tx, ["req", "tkt", "req"]); });
    await settle();
    expect(heard).toHaveLength(1);
    const n = JSON.parse(heard[0]) as { collections: string[]; at: string };
    expect(n.collections).toEqual(["req", "tkt"]);
    expect(Number.isNaN(Date.parse(n.at))).toBe(false);
  });

  it("announces nothing when the transaction rolls back", async () => {
    heard = [];
    await expect(t.db.transaction(async (tx) => {
      await emitChanged(tx, ["stock"]);
      throw new Error("the rule refused");
    })).rejects.toThrow("the rule refused");
    await settle();
    expect(heard).toEqual([]);
  });

  it("says nothing at all for an empty change list", async () => {
    heard = [];
    await t.db.transaction(async (tx) => {
      await emitChanged(tx, []);
      await tx.execute(sql`select 1`);
    });
    await settle();
    expect(heard).toEqual([]);
  });
});
