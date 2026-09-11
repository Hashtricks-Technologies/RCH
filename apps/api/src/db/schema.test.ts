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
  // The integrity migration (0008). Each of these restates a rule a service already keeps; what
  // is being pinned is that a bug, a hand-run UPDATE at 2am or a module written next year cannot
  // talk past it and leave a row the books can never balance again.
  it("refuses an update or delete on document_history", async () => {
    // Drizzle wraps the driver's error and carries it as `.cause`, so the sentence the trigger
    // raises — the one an operator would read in a log — is read from there.
    const refusal = async (q: ReturnType<typeof sql>): Promise<string> => {
      try { await t.db.execute(q); return "it was allowed"; } catch (e) { return String((e as { cause?: Error }).cause?.message); }
    };
    await t.db.execute(sql`insert into document_history(doc_type, doc_id, status, who) values ('ticket','TKT-0001','Issued','Test')`);
    expect(await refusal(sql`update document_history set status = 'Collected' where doc_id = 'TKT-0001'`))
      .toBe("document_history is append-only; append a correcting entry");
    expect(await refusal(sql`delete from document_history where doc_id = 'TKT-0001'`))
      .toBe("document_history is append-only; append a correcting entry");
  });

  it("refuses a zero-quantity stock move at the database", async () => {
    await t.db.execute(sql`insert into locations(key, name, code, type, floor, cost_centre) values ('z','Z','Z','Store','G','CC-Z')`);
    await t.db.execute(sql`insert into items(key, code, name, unit, type, grp, hsn, gst) values ('z','Z','Zero item','nos','RAW','Dairy','0401',0)`);
    await expect(t.db.execute(sql`insert into stock_moves(loc, item_key, qty, kind, ref_type, ref_id) values ('z','z',0,'adjustment','test','zero')`))
      .rejects.toThrow();
    await t.db.execute(sql`insert into stock_moves(loc, item_key, qty, kind, ref_type, ref_id) values ('z','z',1,'adjustment','test','one')`);
  });

  it("refuses a ticket to its own location at the database", async () => {
    await expect(t.db.execute(sql`insert into tickets(id, ref_type, ref_id, from_loc, to_loc, status, otp) values ('TKT-9001','direct','Direct issue','z','z','Issued','123456')`))
      .rejects.toThrow();
  });

  it("makes /readyz green once migrated", async () => {
    const app = await buildTestApp({ schema: "schema_ready" });
    const r = await app.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(200);
    await app.close();
  });
});
