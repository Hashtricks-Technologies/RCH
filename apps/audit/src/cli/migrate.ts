import { ConfigError, loadConfig, type AuditConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { migrateAudit, OutboxMissingError } from "../lib/migrate-run.js";

// Exit codes: 0 migrated (and the role granted, when there is one); 1 anything unexpected;
// 2 the environment is invalid; 3 the API's outbox never appeared.
function readConfig(): AuditConfig {
  try { return loadConfig(process.env); }
  catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(2); } throw e; }
}

const config = readConfig();
// As `rch` (MIGRATE_DATABASE_URL). One connection, because the advisory lock is the session's;
// no statement timeout, because waiting for that lock is this step's job.
const { db, pool } = createDb(config.migrateDatabaseUrl, config.databaseSsl, { max: 1, searchPath: config.auditSchema, statementTimeoutMs: 0 });
let code = 0;
try {
  const r = await migrateAudit(db, config);
  console.log(`audit migrations applied: ${r.applied} / ${r.expected}; ${r.role ? `role ${r.role} granted` : "role setup skipped (the runtime user is the migrate user)"}`);
} catch (e) {
  if (e instanceof OutboxMissingError) { console.error(e.message); code = 3; } else { console.error(e); code = 1; }
} finally {
  await pool.end();
}
process.exit(code);
