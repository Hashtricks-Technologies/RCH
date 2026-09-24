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
// `user_postings` is kept for the same reason `users` is: the one admin account's home row, the
// same row migration 0023 backfills onto a hospital that predates the table. One account, one
// posting - counted in the account test below rather than left uncounted here.
// `roles` is the migration's five, which a reseed never empties - checked in its own case below.
const KEPT = ["locations", "users", "sequences", "user_postings", "roles"];

describe("a bare seed", () => {
  it("keeps the six locations", async () => {
    expect(await count("locations")).toBe(Object.keys(FX.LOC).length);
  });

  it("leaves every other table empty - no item, price, stock, payer, vendor or document", async () => {
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
    expect(await count("user_postings")).toBe(1);
  });

  it("keeps the five roles every hospital starts with, and the admin holds none", async () => {
    const rows = await b.db.select().from(s.roles);
    expect(rows.map((r) => [r.id, r.desk]).sort()).toEqual([["ROLE-001", "counter"], ["ROLE-002", "manager"], ["ROLE-003", "store"], ["ROLE-004", "prod"], ["ROLE-005", "buyer"]]);
    expect((await b.db.select().from(s.users)).map((u) => u.roleId)).toEqual([null]);
  });

  it("numbers every series from where it always has", async () => {
    const rows = await b.db.select().from(s.sequences);
    expect(Object.fromEntries(rows.map((r) => [r.kind, r.next]))).toEqual(SEQUENCE_START);
  });

  it("refuses to run over itself without --force", async () => {
    await expect(seedDatabase(b.db, { password: "bare-seed-password-1", forcePasswordChange: true, bare: true })).rejects.toThrow(/already has 1 users/);
  });
});

describe("a reseed over roles the super admin made", () => {
  let r: TestDb;
  beforeAll(async () => {
    r = await withTestSchema("seed_roles");
    await seedDatabase(r.db, { password: "bare-seed-password-1", forcePasswordChange: true, bare: true });
    await r.db.insert(s.roles).values({ id: "ROLE-009", name: "Shift Lead", desk: "counter", perms: { f: {}, a: [] } });
    await seedDatabase(r.db, { password: "bare-seed-password-1", forcePasswordChange: true, force: true, bare: true });
  });
  afterAll(async () => { await r.close(); });

  it("keeps them, and resumes the role series one past the highest, never back at the start", async () => {
    expect((await r.db.select().from(s.roles)).map((x) => x.id).sort()).toContain("ROLE-009");
    const [row] = await r.db.select().from(s.sequences).where(sql`kind = 'role'`);
    expect(row.next).toBe(10);
    // Everything else starts where it always has.
    const rows = await r.db.select().from(s.sequences);
    expect(Object.fromEntries(rows.filter((x) => x.kind !== "role").map((x) => [x.kind, x.next])))
      .toEqual(Object.fromEntries(Object.entries(SEQUENCE_START).filter(([k]) => k !== "role")));
  });
});
