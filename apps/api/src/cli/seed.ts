import { sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { seedDatabase } from "../db/seed.js";

const config = loadConfig(process.env);
const force = process.argv.includes("--force");
const allowProduction = process.argv.includes("--allow-production");
const yesDestroy = process.argv[process.argv.indexOf("--yes-destroy") + 1];
const production = config.env === "production";

// Seeding a production database is almost always a mistake: it rewrites the password of every
// seeded account, and with --force it empties every table first. Locally it is the ordinary way
// to get a database, so the guard only bites when NODE_ENV says production.
if (production && !allowProduction) {
  console.error("Refusing to seed: NODE_ENV is production, and seeding rewrites every seeded account's password. Pass --allow-production if that is really what you mean.");
  process.exit(2);
}

// statementTimeoutMs: 0 — hashing a password and writing the whole fixture set is allowed to
// take longer than the fifteen seconds a request may.
const { db, pool } = createDb(config.databaseUrl, config.databaseSsl, { max: 2, statementTimeoutMs: 0 });
try {
  // --force truncates every table. In production that is a destruction, so it is spelled out:
  // name the database you mean to empty, and the connection has to agree.
  if (production && force) {
    const [{ name }] = (await db.execute(sql`select current_database() as name`)).rows as [{ name: string }];
    if (yesDestroy !== name) {
      console.error(`Refusing to empty ${name}: --force in production needs --yes-destroy ${name}, and you named ${yesDestroy ? `"${yesDestroy}"` : "nothing"}.`);
      await pool.end();
      process.exit(2);
    }
  }
  await seedDatabase(db, { password: config.seedPassword, forcePasswordChange: config.seedForcePasswordChange, force });
  console.log("seeded");
} finally { await pool.end(); }
