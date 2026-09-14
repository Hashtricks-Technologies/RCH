import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as FX from "@rch/contract/fixtures";
import { SEQUENCE_START } from "@rch/domain";
import { withTestSchema, type TestDb } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { seedDatabase } from "./seed.js";
import * as s from "./schema/index.js";

/**
 * `--bare --force` over the demo hospital - the exact shape of putting a host that was seeded with
 * demo data back to a clean start - and what is left afterwards: the six locations, the document
 * numbering and one admin account, and not a row of anything else.
 */
let b: TestDb;
beforeAll(async () => {
  b = await withTestSchema("seed_bare");
  await seedTestDb(b.db);
  await seedDatabase(b.db, { password: "bare-seed-password-1", forcePasswordChange: true, force: true, bare: true });
});
afterAll(async () => { await b.close(); });

const count = async (table: string) =>
  Number(((await b.db.execute(sql.raw(`select count(*)::int as n from "${table}"`))).rows[0] as { n: number }).n);
const KEPT = ["locations", "users", "sequences"];

describe("a bare seed", () => {
  it("keeps the six locations", async () => {
    expect(await count("locations")).toBe(Object.keys(FX.LOC).length);
  });

  it("leaves every other table empty - no item, recipe, price, stock, payer, vendor or document", async () => {
    const tables = Object.values(s).filter((t) => is(t, PgTable)).map((t) => getTableName(t)).filter((n) => !KEPT.includes(n));
    // Every table the schema has, so a table added later is covered without anyone listing it.
    expect(tables.length).toBeGreaterThan(30);
    const nonEmpty: string[] = [];
    for (const t of tables) if ((await count(t)) > 0) nonEmpty.push(t);
    expect(nonEmpty).toEqual([]);
  });

  it("keeps one account - the admin - and makes it choose its own password first", async () => {
    const rows = await b.db.select().from(s.users);
    expect(rows.map((u) => [u.empNo, u.name, u.admin, u.active, u.mustChangePassword])).toEqual([["RC-0001", "System Administrator", true, true, true]]);
  });

  it("numbers every series from where it always has", async () => {
    const rows = await b.db.select().from(s.sequences);
    expect(Object.fromEntries(rows.map((r) => [r.kind, r.next]))).toEqual(SEQUENCE_START);
  });

  it("refuses to run over itself without --force", async () => {
    await expect(seedDatabase(b.db, { password: "bare-seed-password-1", forcePasswordChange: true, bare: true })).rejects.toThrow(/already has 1 users/);
  });
});
