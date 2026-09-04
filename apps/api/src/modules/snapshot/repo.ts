import { eq } from "drizzle-orm";
import { users } from "../../db/schema/index.js";
import type { Reader } from "../../lib/db.js";
export const snapshotRepo = { userById: async (db: Reader, id: string) => (await db.select().from(users).where(eq(users.id, id)))[0] };
