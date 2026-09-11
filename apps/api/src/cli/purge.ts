import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { purgeIdempotencyKeys } from "../plugins/idempotency.js";
import { purgeRefreshTokens } from "../modules/auth/repo.js";

const config = loadConfig(process.env);
// statementTimeoutMs: 0 — a nightly sweep of expired keys and tokens grows with how long the
// job was last skipped, so it is allowed to take longer than a request may.
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1, statementTimeoutMs: 0 });
console.log(`idempotency keys purged: ${await purgeIdempotencyKeys(db)}`);
console.log(`refresh tokens purged: ${await purgeRefreshTokens(db)}`);
await pool.end();
