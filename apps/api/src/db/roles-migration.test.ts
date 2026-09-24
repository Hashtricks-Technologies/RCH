import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { DESK_DEFAULTS } from "@rch/domain";
import { createDb, type Db } from "./client.js";

/**
 * `0026_roles` against a hospital that already has staff: the database is migrated to 0025 from a
 * copy of `drizzle/` with the journal cut there, one account per desk and a super admin are written
 * the way 0025 knew them, and then the real folder is migrated over it. Every account must come out
 * on its desk's seeded role, labelled with its name, and the super admin on none.
 */
const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";
const schemaName = `t_roles_migration_${process.pid}`;
const real = fileURLToPath(new URL("../../drizzle", import.meta.url));
let cut: string;
let db: Db;
let pool: Pool;

const admin = async (q: string) => { const p = new Pool({ connectionString: BASE, max: 1 }); await p.query(q); await p.end(); };

beforeAll(async () => {
  await admin(`drop schema if exists "${schemaName}" cascade`);
  await admin(`create schema "${schemaName}"`);
  cut = mkdtempSync(join(tmpdir(), "rch-drizzle-0025-"));
  cpSync(real, cut, { recursive: true });
  const journal = JSON.parse(readFileSync(join(real, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  const at = journal.entries.findIndex((e) => e.tag === "0026_roles");
  expect(at).toBeGreaterThan(0);
  writeFileSync(join(cut, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }));
  ({ db, pool } = createDb(BASE, false, { max: 2, searchPath: `${schemaName},public` }));
  await migrate(db, { migrationsFolder: cut, migrationsSchema: schemaName });

  await db.execute(sql`insert into locations (key, name, code, type, floor, cost_centre) values
    ('store', 'Central Store', 'CS', 'Store', 'Basement', 'CC-1'),
    ('kitchen', 'Central Kitchen', 'CK', 'Kitchen', 'Ground', 'CC-2'),
    ('coffee', 'Coffee Shop', 'OT-CF', 'Outlet', 'Ground', 'CC-3')`);
  const person = (id: string, role: string, label: string, loc: string, isAdmin = false) =>
    sql`(${id}, ${`Person ${id}`}, ${`${id}@royalcare.in`}, ${role}, ${label}, ${loc}, '#000000', ${`RC-9${id.slice(1).padStart(3, "0")}`}, '', 'x', ${isAdmin})`;
  await db.execute(sql`insert into users (id, name, email, role, role_label, loc, colour, emp_no, phone, password_hash, admin) values
    ${sql.join([
      person("u1", "counter", "Counter Operator", "coffee"),
      person("u2", "manager", "Outlet Manager", "coffee"),
      person("u3", "store", "Store Keeper", "store"),
      person("u4", "prod", "Kitchen In-charge", "kitchen"),
      person("u5", "buyer", "Procurement Officer", "store"),
      person("u7", "manager", "Outlet Manager", "store", true),
    ], sql`, `)}`);

  await migrate(db, { migrationsFolder: real, migrationsSchema: schemaName });
});
afterAll(async () => {
  await pool?.end();
  await admin(`drop schema if exists "${schemaName}" cascade`);
  if (cut) rmSync(cut, { recursive: true, force: true });
});

describe("0026_roles", () => {
  it("seeds one role per desk, holding exactly the desk's defaults", async () => {
    const rows = (await db.execute(sql`select id, name, desk, perms, active, ever_assigned from roles order by id`)).rows;
    expect(rows).toEqual((["counter", "manager", "store", "prod", "buyer"] as const).map((desk, i) => ({
      id: `ROLE-00${i + 1}`, name: DESK_DEFAULTS[desk].name, desk, perms: DESK_DEFAULTS[desk].perms, active: true, ever_assigned: true,
    })));
  });
  it("puts every existing account on its desk's role, and the super admin on none", async () => {
    const rows = (await db.execute(sql`select id, role_id, role_label from users order by id`)).rows;
    expect(rows).toEqual([
      { id: "u1", role_id: "ROLE-001", role_label: "Counter Operator" },
      { id: "u2", role_id: "ROLE-002", role_label: "Outlet Manager" },
      { id: "u3", role_id: "ROLE-003", role_label: "Store Keeper" },
      { id: "u4", role_id: "ROLE-004", role_label: "Kitchen In-charge" },
      { id: "u5", role_id: "ROLE-005", role_label: "Procurement Officer" },
      { id: "u7", role_id: null, role_label: "Outlet Manager" },
    ]);
  });
  it("refuses an ordinary account with no role, and a role on another desk than the account's", async () => {
    await expect(db.execute(sql`update users set role_id = null where id = 'u1'`)).rejects.toThrow();
    await expect(db.execute(sql`update users set role_id = 'ROLE-003' where id = 'u1'`)).rejects.toThrow();
  });
});
