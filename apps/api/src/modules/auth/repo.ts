import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../lib/db.js";
import { refreshTokens, users } from "../../db/schema/index.js";

export const authRepo = {
  userByEmp: async (db: Db | Tx, emp: string) => (await db.select().from(users).where(eq(users.empNo, emp)))[0],
  userById: async (db: Db | Tx, id: string) => (await db.select().from(users).where(eq(users.id, id)))[0],
  /** The sign-in picker: every account that can sign in at a counter or a desk — active, and not
   *  admin-flagged, so the one account that manages the others is not advertised to whoever
   *  opens the page — as a number and a name, in number order. */
  signInDirectory: (db: Db | Tx) =>
    db.select({ emp: users.empNo, n: users.name }).from(users)
      .where(and(eq(users.active, true), eq(users.admin, false)))
      .orderBy(asc(users.empNo)),
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

/** How many rows one DELETE of the nightly sweep takes — see purgeRefreshTokens. */
const PURGE_BATCH = 10_000;

/**
 * Nightly housekeeping (cli/purge.ts), a bounded batch at a time. Nothing else ever deletes from
 * this table, so without it every sign-in the hospital ever performs stays on disk for good —
 * and the first run after this ships meets all of them at once. Rows that can no longer authorise
 * anything go: expired ones, and revoked ones past a week's grace, long enough that "why was I
 * signed out on Tuesday?" can still be answered from the row.
 *
 * The loop is what keeps that first run from being a single DELETE holding one transaction and
 * one set of row locks over every session ever opened, against a table every sign-in and every
 * refresh is writing to. `ctid in (select ctid … limit n)` is "any n of the matching rows": ctid
 * is a tuple's physical address, so the delete goes straight at the rows the subquery picked with
 * no second lookup. Note what the subquery is NOT doing — there is no index on `expires_at` or
 * `revoked_at` (schema/infra.ts indexes token_hash, family and user_id), so it is a sequential
 * scan, bounded by the LIMIT. That is fine for a job that runs once a night and stops as soon as
 * it has its ten thousand; if it ever shows up in an EXPLAIN worth caring about, the fix is a
 * partial index on the two dead-row predicates, not a bigger batch.
 *
 * `batch` is a parameter so a test can make it smaller than the work; nothing in production
 * passes it.
 */
export async function purgeRefreshTokens(db: Db, batch: number = PURGE_BATCH): Promise<number> {
  // The expiry half takes one cutoff for the whole sweep rather than a fresh `new Date()` per
  // batch, which would walk forward between statements. The revoked half is `now()` *inside* the
  // statement, so Postgres does re-evaluate it per batch — deliberately left that way: against a
  // seven-day grace a row has to be a week old to qualify, and no sweep runs long enough to move
  // one across that line, so pinning it would only swap the database's clock for the app
  // server's for no gain.
  const dead = or(lt(refreshTokens.expiresAt, new Date()), lt(refreshTokens.revokedAt, sql`now() - interval '7 days'`));
  let total = 0;
  for (;;) {
    const r = await db.delete(refreshTokens).where(
      sql`ctid in (select ctid from ${refreshTokens} where ${dead} limit ${batch})`,
    );
    const n = r.rowCount ?? 0;
    total += n;
    if (n < batch) return total;
  }
}
