import { sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { seedDatabase } from "../db/seed.js";
import { seedGuard } from "../lib/seed-guard.js";

const config = loadConfig(process.env);
const argv = process.argv.slice(2);
const force = argv.includes("--force");

// statementTimeoutMs: 0 — hashing a password and writing the whole fixture set is allowed to
// take longer than the fifteen seconds a request may.
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 2, statementTimeoutMs: 0 });
try {
  // Both production guards ask for the database's own name back, so the connection has to be
  // open before either can be decided — which is why this sits inside the try rather than above
  // it. The rules themselves are in `lib/seed-guard.ts`; this is argv in, a sentence out.
  const [{ name }] = (await db.execute(sql`select current_database() as name`)).rows as [{ name: string }];
  const decision = seedGuard({ env: config.env, argv, dbName: name });
  if ("exit" in decision) {
    console.error(decision.message);
    await pool.end();
    process.exit(decision.exit);
  }
  await seedDatabase(db, { password: config.seedPassword, forcePasswordChange: config.seedForcePasswordChange, force });
  console.log("seeded");
} finally { await pool.end(); }
