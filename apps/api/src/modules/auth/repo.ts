import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../lib/db.js";
import { refreshTokens, users } from "../../db/schema/index.js";

export const authRepo = {
  userByEmp: async (db: Db | Tx, emp: string) => (await db.select().from(users).where(eq(users.empNo, emp)))[0],
  userById: async (db: Db | Tx, id: string) => (await db.select().from(users).where(eq(users.id, id)))[0],
  insertRefresh: (tx: Tx, v: { userId: string; family: string; tokenHash: string; expiresAt: Date; userAgent?: string; ip?: string }) => tx.insert(refreshTokens).values(v),
  refreshByHash: async (db: Db | Tx, tokenHash: string) => (await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)))[0],
  /** Atomic claim: only flips `used_at` if it is still null, and reports whether it won.
   *  Two concurrent refreshes of the same token race this UPDATE, not a prior SELECT — the
   *  loser's WHERE no longer matches once the winner commits, so it claims zero rows. */
  markUsed: (tx: Tx, id: string) =>
    tx.update(refreshTokens).set({ usedAt: new Date() }).where(and(eq(refreshTokens.id, id), isNull(refreshTokens.usedAt))).returning({ id: refreshTokens.id }),
  revokeFamily: (tx: Tx, family: string) => tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.family, family), isNull(refreshTokens.revokedAt))),
  revokeAllForUser: (tx: Tx, userId: string) => tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt))),
  setPassword: (tx: Tx, userId: string, passwordHash: string) => tx.update(users).set({ passwordHash, mustChangePassword: false, updatedAt: new Date() }).where(eq(users.id, userId)),
};
