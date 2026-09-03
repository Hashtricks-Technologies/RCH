import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { purgeIdempotencyKeys } from "../plugins/idempotency.js";
import { purgeRefreshTokens } from "../modules/auth/repo.js";

const config = loadConfig(process.env);
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 1 });
console.log(`idempotency keys purged: ${await purgeIdempotencyKeys(db)}`);
console.log(`refresh tokens purged: ${await purgeRefreshTokens(db)}`);
await pool.end();
