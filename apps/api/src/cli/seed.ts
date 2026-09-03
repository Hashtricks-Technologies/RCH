import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { seedDatabase } from "../db/seed.js";

const config = loadConfig(process.env);
const force = process.argv.includes("--force");
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 2 });
try {
  await seedDatabase(db, { password: config.seedPassword, forcePasswordChange: config.seedForcePasswordChange, force });
  console.log("seeded");
} finally { await pool.end(); }
