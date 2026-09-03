import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../lib/db.js";
import { users } from "../../db/schema/index.js";

export const meRepo = {
  byId: async (db: Db | Tx, id: string) => (await db.select().from(users).where(eq(users.id, id)))[0],
  update: (tx: Tx, id: string, patch: { name?: string; email?: string; phone?: string }) => tx.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, id)),
};
