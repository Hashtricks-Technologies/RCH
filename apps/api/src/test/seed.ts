import type { Db } from "../db/client.js";
import { seedDatabase } from "../db/seed.js";

export const seedTestDb = (db: Db) => seedDatabase(db, { password: "changeme", forcePasswordChange: false, force: true });
