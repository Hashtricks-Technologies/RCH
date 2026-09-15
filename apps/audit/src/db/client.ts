import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

/** RDS connections verify the AWS CA bundle baked into the image. Shared with the drainer's
 *  dedicated LISTEN client, which is not a pool member. */
export function pgSsl(ssl: boolean): ConnectionOptions | undefined {
  return ssl ? { rejectUnauthorized: true, ca: readFileSync(process.env.PG_CA_BUNDLE ?? "/etc/ssl/rds-global-bundle.pem", "utf8") } : undefined;
}

/** `DATABASE_SSL` alone decides TLS: an `sslmode=` on the URL would make the driver ignore the
 *  `ssl` object and verify against the system store instead (apps/api/src/db/client.ts). */
export function withoutSslParams(url: string): string {
  const u = new URL(url);
  for (const k of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey"]) u.searchParams.delete(k);
  return u.toString();
}

/**
 * One pool per process, on `search_path = searchPath` (AUDIT_SCHEMA) so the unqualified tables in
 * `schema.ts` and the migrations resolve to the audit schema. The outbox is never reached through
 * the path; it is always named with its schema.
 *
 * `statementTimeoutMs` is 15 s for the service. The migrate CLI passes 0: it waits inside a
 * statement for the advisory lock while another replica migrates.
 */
export function createDb(url: string, ssl: boolean, opts: { max: number; searchPath?: string; statementTimeoutMs?: number }): { db: Db; pool: Pool } {
  const pool = new Pool({
    connectionString: withoutSslParams(url),
    max: opts.max,
    ssl: pgSsl(ssl),
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: "rch-audit",
    options: opts.searchPath ? `-c search_path=${opts.searchPath}` : undefined,
  });
  return { db: drizzle({ client: pool, schema }), pool };
}
