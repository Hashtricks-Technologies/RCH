import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
export const snapshotRepo = { userById: async (db: Db, id: string) => (await db.select().from(users).where(eq(users.id, id)))[0] };
