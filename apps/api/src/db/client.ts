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

/** One pool per process. RDS connections verify the AWS CA bundle baked into the image (Task 15). */
export function createDb(url: string, ssl: boolean, opts: { max?: number; searchPath?: string } = {}): { db: Db; pool: Pool } {
  const pool = new Pool({
    connectionString: url,
    max: opts.max ?? 10,
    ssl: pgSsl(ssl),
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
    options: opts.searchPath ? `-c search_path=${opts.searchPath}` : undefined,
  });
  return { db: drizzle({ client: pool, schema }), pool };
}
