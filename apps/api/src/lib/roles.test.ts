import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { withTestSchema, type TestDb } from "../test/db.js";
import { applyAppRole, ensureLoginRole, grantAppRole, roleFromUrls } from "./roles.js";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";
/** Roles belong to the cluster, not to a schema, so the name carries the pid for the same reason
 *  test schemas do: two checkouts on one Postgres must not grant or drop each other's. */
const ROLE = `t_app_${process.pid}`;
const FIRST = "t-app-password-1";
const SECOND = "t-app-password-2";
const DENIED = { code: "42501" };
const as = (url: string, user: string, password: string): string => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

describe("roleFromUrls", () => {
  it("answers null when both URLs name the same user - migrate as the runtime user, and leave roles alone", () => {
    expect(roleFromUrls("postgres://rch:rch@localhost:5439/rch", "postgres://rch:other@db:5432/rch")).toBeNull();
  });
  it("reads the runtime role's name and its decoded password", () => {
    expect(roleFromUrls("postgres://rch_app:p%40ss%3Aw0rd@postgres:5432/rch", "postgres://rch:rch@postgres:5432/rch"))
      .toEqual({ name: "rch_app", password: "p@ss:w0rd" });
  });
  it("refuses a runtime URL that names somebody else without a password, or names nobody", () => {
    expect(() => roleFromUrls("postgres://rch_app@postgres:5432/rch", "postgres://rch:rch@postgres:5432/rch")).toThrow(/carries no password/);
    expect(() => roleFromUrls("postgres://postgres:5432/rch", "postgres://rch:rch@postgres:5432/rch")).toThrow(/names no user/);
  });
});

describe("the API's runtime role", () => {
  let t: TestDb;
  let asApp: Pool;
  const other = `t_roles_other_${process.pid}`;
  const opts = () => ({ schema: t.schemaName, migrationsSchema: t.schemaName });
  const connectAs = (password: string) => new Pool({ connectionString: as(BASE, ROLE, password), max: 1, options: `-c search_path=${t.schemaName}` });
  /** `drop owned by` first: the role holds grants and default privileges, and a role with either
   *  cannot be dropped. Also clears what a crashed earlier run with this pid left behind. */
  const dropRole = async (admin: Pool) => {
    const { rows } = await admin.query("select 1 from pg_roles where rolname = $1", [ROLE]);
    if (rows.length === 0) return;
    await admin.query(`drop owned by "${ROLE}"`);
    await admin.query(`drop role "${ROLE}"`);
  };

  beforeAll(async () => {
    t = await withTestSchema("roles");
    const admin = new Pool({ connectionString: BASE, max: 1 });
    await dropRole(admin);
    // A schema the role is never granted, with a table in it: the stand-in for every schema that
    // is not the API's own (`audit`, `audit_drizzle` in a deployment).
    await admin.query(`drop schema if exists "${other}" cascade`);
    await admin.query(`create schema "${other}"`);
    await admin.query(`create table "${other}".kept (id int)`);
    await admin.end();
    await ensureLoginRole(t.db, { name: ROLE, password: FIRST });
    await grantAppRole(t.db, ROLE, opts());
    asApp = connectAs(FIRST);
  });
  afterAll(async () => {
    await asApp.end();
    const admin = new Pool({ connectionString: BASE, max: 1 });
    await dropRole(admin);
    await admin.query(`drop schema if exists "${other}" cascade`);
    await admin.end();
    await t.close();
  });

  it("reads and writes an ordinary table", async () => {
    await expect(asApp.query("insert into vendors (id, name) values ('VN-ROLE', 'Role probe')")).resolves.toMatchObject({ rowCount: 1 });
    await expect(asApp.query("update vendors set contact = 'probe' where id = 'VN-ROLE'")).resolves.toMatchObject({ rowCount: 1 });
    await expect(asApp.query("select id from vendors where id = 'VN-ROLE'")).resolves.toMatchObject({ rowCount: 1 });
    await expect(asApp.query("delete from vendors where id = 'VN-ROLE'")).resolves.toMatchObject({ rowCount: 1 });
  });

  it("reads the migrations bookkeeping, which /readyz counts", async () => {
    const { rows } = await asApp.query<{ n: number }>(`select count(*)::int as n from "${t.schemaName}"."__drizzle_migrations"`);
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it("can add to the audit outbox and can do nothing else with it", async () => {
    await expect(asApp.query("insert into audit_outbox (event) values ('{}'::jsonb)")).resolves.toMatchObject({ rowCount: 1 });
    await expect(asApp.query("select id from audit_outbox")).rejects.toMatchObject(DENIED);
    await expect(asApp.query("update audit_outbox set event = '{}'::jsonb")).rejects.toMatchObject(DENIED);
    await expect(asApp.query("delete from audit_outbox")).rejects.toMatchObject(DENIED);
    await expect(asApp.query("truncate audit_outbox")).rejects.toMatchObject(DENIED);
  });

  it("can neither create a table nor read a schema it was not granted", async () => {
    await expect(asApp.query("create table role_probe (id int)")).rejects.toMatchObject(DENIED);
    await expect(asApp.query(`select id from "${other}".kept`)).rejects.toMatchObject(DENIED);
  });

  it("leaves roles alone when the runtime and migrate URLs name the same user", async () => {
    expect(await applyAppRole(t.db, { runtime: BASE, migrate: BASE }, opts())).toBeNull();
  });

  it("re-runs cleanly on the next deploy: the password follows the URL and the outbox stays insert-only", async () => {
    expect(await applyAppRole(t.db, { runtime: as(BASE, ROLE, SECOND), migrate: BASE }, opts())).toBe(ROLE);
    const again = connectAs(SECOND);
    try {
      await expect(again.query("insert into audit_outbox (event) values ('{}'::jsonb)")).resolves.toMatchObject({ rowCount: 1 });
      await expect(again.query("select id from audit_outbox")).rejects.toMatchObject(DENIED);
    } finally {
      await again.end();
    }
    const stale = connectAs(FIRST);
    try {
      await expect(stale.query("select 1")).rejects.toMatchObject({ code: "28P01" });
    } finally {
      await stale.end();
    }
  });
});
