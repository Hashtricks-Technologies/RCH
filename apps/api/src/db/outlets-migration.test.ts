import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { withTestSchema, type TestDb } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { uniqueViolationOf } from "../lib/db.js";

/**
 * The outlets migration against the seeded hospital. The par-factor backfill is the one statement
 * whose effect a freshly migrated schema cannot show - the rows it updates are inserted after it -
 * so the statement is read out of the migration file and run again over rows put back to the
 * column default, which is exactly the state a live database is in when the migration reaches it.
 */
let t: TestDb;
beforeAll(async () => { t = await withTestSchema("outlets_migration"); await seedTestDb(t.db); });
afterAll(async () => { await t.close(); });

const backfill = (): string => {
  const file = readFileSync(new URL("../../drizzle/0017_outlets.sql", import.meta.url), "utf8");
  const stmt = file.split("--> statement-breakpoint").map((s) => s.trim()).find((s) => s.includes(`UPDATE "locations" SET "par_factor"`));
  if (!stmt) throw new Error("0017_outlets.sql carries no par_factor backfill");
  return stmt;
};
const insertOutlet = (key: string, name: string, code: string) =>
  t.db.execute(sql`insert into locations(key, name, code, type, floor, cost_centre) values (${key}, ${name}, ${code}, 'Outlet', 'Ground', 'CC-X')`);
const refusalOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try { await p; return undefined; } catch (e) { return uniqueViolationOf(e); }
};

describe("0017_outlets", () => {
  it("backfills today's par factors, so no par level moves", async () => {
    await t.db.execute(sql`update locations set par_factor = 0.18`);
    await t.db.execute(sql.raw(backfill()));
    const rows = (await t.db.execute(sql`select key, par_factor::float8 as par from locations`)).rows as { key: string; par: number }[];
    expect(Object.fromEntries(rows.map((r) => [r.key, r.par]))).toEqual({ store: 1, kitchen: 0.35, rest: 0.22, coffee: 0.18, kiosk: 0.15, quarantine: 1 });
  });
  it("opens a new location with the default factor", async () => {
    await insertOutlet("juice-bar", "Juice Bar", "OT-JB");
    const [row] = (await t.db.execute(sql`select active, par_factor::float8 as par from locations where key = 'juice-bar'`)).rows;
    expect(row).toEqual({ active: true, par: 0.18 });
  });
  it("refuses a second location with the same name or code in another case", async () => {
    expect(await refusalOf(insertOutlet("juice-bar-2", "JUICE BAR", "OT-J2"))).toBe("locations_name_uq");
    expect(await refusalOf(insertOutlet("juice-bar-3", "Juice Hut", "ot-jb"))).toBe("locations_code_uq");
  });
  it("names no constraint for an error that is not a unique violation", () => {
    expect(uniqueViolationOf(new Error("boom"))).toBeUndefined();
    expect(uniqueViolationOf({ cause: { code: "23503", constraint: "x" } })).toBeUndefined();
  });
});
