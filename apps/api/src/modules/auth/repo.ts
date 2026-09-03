import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../lib/db.js";
import { refreshTokens, users } from "../../db/schema/index.js";

export const authRepo = {
  userByEmp: async (db: Db | Tx, emp: string) => (await db.select().from(users).where(eq(users.empNo, emp)))[0],
  userById: async (db: Db | Tx, id: string) => (await db.select().from(users).where(eq(users.id, id)))[0],
  insertRefresh: (tx: Tx, v: { userId: string; family: string; tokenHash: string; expiresAt: Date; userAgent?: string; ip?: string }) => tx.insert(refreshTokens).values(v),
  refreshByHash: async (db: Db | Tx, tokenHash: string) => (await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)))[0],
  /** When the family's very first token was issued — undefined if the family has no rows yet
   *  (a brand-new login, about to insert its own first row). Caps how long a refresh chain
   *  can be kept alive by rotation alone: see `issue()` in service.ts.
   *  min() on a timestamptz column comes back from `pg` as a string, not a Date — the `sql<Date>`
   *  type param is a TS-only cast, so it has to be parsed explicitly. */
  familyStartedAt: async (tx: Tx, family: string): Promise<Date | undefined> => {
    const [row] = await tx.select({ min: sql<string | null>`min(${refreshTokens.createdAt})` }).from(refreshTokens).where(eq(refreshTokens.family, family));
    return row?.min ? new Date(row.min) : undefined;
  },
  /** Atomic claim: only flips `used_at` if it is still null, and reports whether it won.
   *  Two concurrent refreshes of the same token race this UPDATE, not a prior SELECT — the
   *  loser's WHERE no longer matches once the winner commits, so it claims zero rows. */
  markUsed: (tx: Tx, id: string) =>
    tx.update(refreshTokens).set({ usedAt: new Date() }).where(and(eq(refreshTokens.id, id), isNull(refreshTokens.usedAt))).returning({ id: refreshTokens.id }),
  revokeFamily: (tx: Tx, family: string) => tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.family, family), isNull(refreshTokens.revokedAt))),
  revokeAllForUser: (tx: Tx, userId: string) => tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt))),
  setPassword: (tx: Tx, userId: string, passwordHash: string) => tx.update(users).set({ passwordHash, mustChangePassword: false, updatedAt: new Date() }).where(eq(users.id, userId)),
};

/**
 * Nightly housekeeping (cli/purge.ts). Nothing else ever deletes from this table, so without
 * it every sign-in the hospital ever performs stays on disk for good. Rows that can no longer
 * authorise anything go: expired ones, and revoked ones past a week's grace — long enough that
 * "why was I signed out on Tuesday?" can still be answered from the row.
 */
export async function purgeRefreshTokens(db: Db): Promise<number> {
  const r = await db.delete(refreshTokens).where(
    or(lt(refreshTokens.expiresAt, new Date()), lt(refreshTokens.revokedAt, sql`now() - interval '7 days'`)),
  );
  return r.rowCount ?? 0;
}
