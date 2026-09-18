import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { createDb, type Db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import * as schema from "../db/schema/index.js";
import { seedDocuments } from "../db/seed.js";
import { withTransaction } from "../lib/db.js";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";

export type TestDb = { db: Db; pool: Pool; schemaName: string; close(): Promise<void> };

/** Creates schema `t_<name>_<pid>`, migrates into it, returns a Db whose search_path is that schema.
 *  The pid keeps two checkouts running the same file against one database (parallel worktrees
 *  share port 5439) from dropping each other's schema mid-test; `close` drops it again. */
export async function withTestSchema(name: string): Promise<TestDb> {
  const schemaName = `t_${name.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}_${process.pid}`;
  const admin = new Pool({ connectionString: BASE, max: 1 });
  await admin.query(`drop schema if exists "${schemaName}" cascade`);
  await admin.query(`create schema "${schemaName}"`);
  await admin.end();
  const { db, pool } = createDb(BASE, false, { max: 4, searchPath: `${schemaName},public` });
  await runMigrations(db, schemaName);
  return {
    db, pool, schemaName,
    close: async () => {
      await pool.end();
      const admin = new Pool({ connectionString: BASE, max: 1 });
      await admin.query(`drop schema if exists "${schemaName}" cascade`);
      await admin.end();
    },
  };
}

/**
 * Grow the pool to `n` live connections, then hand them straight back.
 *
 * `pg` gives a waiting caller an idle client instead of opening a second one, so two
 * transactions started in the same tick against a pool that has only ever needed one client
 * run back to back - the second does not even reach its BEGIN until the first has committed.
 * A case about two writers racing for the same row then passes whether or not the lock under
 * test exists. Call this before racing anything.
 */
export async function warmPool(t: TestDb, n = 2): Promise<void> {
  const held = await Promise.all(Array.from({ length: n }, () => t.pool.connect()));
  for (const c of held) c.release();
}

/** Empty every business table between tests; keep sequences and migrations. */
export async function truncateAll(db: Db): Promise<void> {
  const names = Object.values(schema)
    .filter((t) => is(t, PgTable))
    .map((t) => getTableName(t))
    .filter((n) => n !== "sequences");
  await db.execute(sql.raw(`truncate table ${names.map((n) => `"${n}"`).join(", ")} restart identity cascade`));
}

/**
 * The per-case reset: empty the document and vendor tables and re-seed them, leaving master data,
 * users and payers exactly as the file's `beforeAll` left them. A suite that was paying for a
 * whole hospital between cases pays for the documents instead.
 *
 * The table list is explicit rather than derived: `truncateAll` takes every table in the schema
 * and that is what makes it slow, and a derived "everything except master" list would silently
 * start truncating each new table a later phase adds. Add a table here on purpose or not at all.
 */
export async function resetDocuments(db: Db): Promise<void> {
  const names = [
    "stock_requests", "stock_request_lines", "tickets", "ticket_lines", "shop_asks",
    "requisitions", "requisition_lines", "purchase_orders", "po_lines", "po_line_sources", "grns",
    "prod_orders", "prod_order_lines", "batches", "bills", "bill_lines",
    "support_tickets", "support_messages", "product_requests",
    "vendors", "rate_contracts",
    "stock_moves", "stock_balances", "reservations", "availability_overrides",
    "document_history", "idempotency_keys",
    // ---- audit log: every write now leaves an event, and a case counting them must not see the last case's
    "audit_outbox",
    // ---- adjustments
    "adjustments", "adjustment_lines",
    // ---- settlements. `settlement_lines` would go with the bills anyway (it points at them, so
    // the cascade reaches it), but `settlements` itself points only at `payers`, which stays -
    // so without this line a case's payments would outlive the bills they settled. The rate card
    // is deliberately absent: it is master data the manager sets, like a price list.
    "settlements", "settlement_lines",
    // ---- the register. `bills` points at it, not the other way round, so the cascade above never
    // reaches it: without this line an open session outlives the reset and the next case's first
    // sale joins the last case's business day.
    "register_sessions",
  ];
  await db.execute(sql.raw(`truncate table ${names.map((n) => `"${n}"`).join(", ")} restart identity cascade`));
  await withTransaction(db, async (tx) => { await seedDocuments(tx); });
}
