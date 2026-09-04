import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

/** RDS connections verify the AWS CA bundle baked into the image. Shared with the SSE
 *  plugin's dedicated LISTEN connection, which is not a pool member. */
export function pgSsl(ssl: boolean): ConnectionOptions | undefined {
  return ssl ? { rejectUnauthorized: true, ca: readFileSync(process.env.PG_CA_BUNDLE ?? "/etc/ssl/rds-global-bundle.pem", "utf8") } : undefined;
}

/**
 * One pool per process. RDS connections verify the AWS CA bundle baked into the image (Task 15).
 *
 * `max` is `DB_POOL_MAX` (config.ts), default **10** — one pod's share of the instance's own
 * `max_connections`. It is deliberately not the first knob to reach for when `/snapshot` is slow:
 * a request takes exactly one connection (`withReadTransaction`, `lib/db.ts`), so a pool at its
 * ceiling means genuinely that many requests in flight, not one request holding forty.
 */
/**
 * `DATABASE_SSL` alone decides TLS. A `sslmode=` (or `ssl=`) query parameter on the URL makes the
 * driver build its own `ssl` setting from the string and ignore the `ssl` object below — so a
 * URL carrying `?sslmode=require` verified the RDS chain against the system store, not the RDS
 * bundle, and the migrate initContainer died with SELF_SIGNED_CERT_IN_CHAIN on the first dev
 * deploy. The parameters are removed here so the bundle is used whenever `ssl` is true.
 */
export function withoutSslParams(url: string): string {
  const u = new URL(url);
  for (const k of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey"]) u.searchParams.delete(k);
  return u.toString();
}

export function createDb(url: string, ssl: boolean, opts: { max?: number; searchPath?: string } = {}): { db: Db; pool: Pool } {
  const pool = new Pool({
    connectionString: withoutSslParams(url),
    max: opts.max ?? 10,
    ssl: pgSsl(ssl),
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
    options: opts.searchPath ? `-c search_path=${opts.searchPath}` : undefined,
  });
  return { db: drizzle({ client: pool, schema }), pool };
}
