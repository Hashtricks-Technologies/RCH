import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { withTestSchema, type TestDb } from "../test/db.js";
import { buildTestApp } from "../test/app.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("schema"); });
afterAll(async () => { await t.close(); });

describe("schema", () => {
  it("migrates every table into the test schema", async () => {
    const r = await t.db.execute(sql`select table_name from information_schema.tables where table_schema = ${t.schemaName} order by 1`);
    const names = r.rows.map((x) => (x as { table_name: string }).table_name);
    for (const n of ["stock_moves", "stock_balances", "reservations", "stock_requests", "tickets", "bills", "payers", "purchase_orders", "grns", "sequences", "refresh_tokens", "idempotency_keys", "document_history"])
      expect(names).toContain(n);
  });
  it("refuses a second item with the same name in a different case", async () => {
    await t.db.execute(sql`insert into items(key, code, name, unit, type, grp, hsn, gst) values ('a','A','Milk 1L','L','RAW','Dairy','0401',0)`);
    await expect(t.db.execute(sql`insert into items(key, code, name, unit, type, grp, hsn, gst) values ('b','B','milk 1l','L','RAW','Dairy','0401',0)`)).rejects.toThrow();
  });
  it("makes /readyz green once migrated", async () => {
    const app = await buildTestApp({ schema: "schema_ready" });
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(200);
    await app.close();
  });
});
