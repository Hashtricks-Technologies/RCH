import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Role } from "@rch/contract";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../lib/db.js";
import { locations, refreshTokens, roles, userPostings, users } from "../../db/schema/index.js";

export const authRepo = {
  userByEmp: async (db: Db | Tx, emp: string) => (await db.select().from(users).where(eq(users.empNo, emp)))[0],
  userById: async (db: Db | Tx, id: string) => (await db.select().from(users).where(eq(users.id, id)))[0],
  /** The sign-in picker: every account that can sign in at a counter or a desk - active, not
   *  admin-flagged, so the one account that manages the others is not advertised to whoever
   *  opens the page, and not a system account, which nobody signs in as - as a number and a
   *  name, in number order. */
  signInDirectory: async (db: Db | Tx): Promise<{ emp: string; n: string; locs: { k: string; n: string; c: string }[] }[]> => {
    // One query, not one per account: each posting comes back as an object in an aggregate, name
    // and code included - nothing on the sign-in screen can look a location up, because the
    // registries that hold them are filled by the snapshot and the snapshot needs a token.
    //
    // `left join` on the postings and not `join`: an account whose rows were removed by hand must
    // still be able to sign in, and falls back to its home location below.
    const home = alias(locations, "home_loc");
    const rows = await db.select({
      emp: users.empNo, n: users.name,
      // A two-sided account is asked Billing or Inventory after the password, and where after that, so
      // there is no counter to choose here - and the public list says nothing about its role.
      twoSided: sql<boolean>`coalesce(bool_or(${roles.inventoryPerms} is not null), false)`,
      homeLoc: sql<{ k: string; n: string; c: string }>`json_build_object('k', ${home.key}, 'n', ${home.name}, 'c', ${home.code})`,
      locs: sql<{ k: string; n: string; c: string }[]>`coalesce(json_agg(json_build_object('k', ${locations.key}, 'n', ${locations.name}, 'c', ${locations.code}) order by ${locations.key}) filter (where ${locations.key} is not null), '[]')`,
    }).from(users)
      .innerJoin(home, eq(home.key, users.loc))
      .leftJoin(roles, eq(roles.id, users.roleId))
      .leftJoin(userPostings, eq(userPostings.userId, users.id))
      .leftJoin(locations, eq(locations.key, userPostings.loc))
      .where(and(eq(users.active, true), eq(users.admin, false), eq(users.system, false)))
      .groupBy(users.empNo, users.name, home.key, home.name, home.code)
      .orderBy(asc(users.empNo));
    return rows.map((r) => ({ emp: r.emp, n: r.n, locs: r.locs.length && !r.twoSided ? r.locs : [r.homeLoc] }));
  },
  insertRefresh: (tx: Tx, v: { userId: string; family: string; tokenHash: string; expiresAt: Date; userAgent?: string; ip?: string; loc: string; desk: Role | null }) => tx.insert(refreshTokens).values(v),
  refreshByHash: async (db: Db | Tx, tokenHash: string) => (await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)))[0],
  /** The live session behind a cookie, locked: a rotation of the same row waits for the switch, and
   *  a switch that loses to one finds the row used. */
  refreshForUpdate: async (tx: Tx, tokenHash: string) => (await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).for("update"))[0],
  /** Moves one two-sided session to another side or outlet. By row, so none of that account's other
   *  sessions moves with it. */
  setStanding: (tx: Tx, id: string, at: { desk: Role; loc: string }) =>
    tx.update(refreshTokens).set({ desk: at.desk, loc: at.loc }).where(eq(refreshTokens.id, id)),
  /** When the family's very first token was issued - undefined if the family has no rows yet
   *  (a brand-new login, about to insert its own first row). Caps how long a refresh chain
   *  can be kept alive by rotation alone: see `issue()` in service.ts.
   *  min() on a timestamptz column comes back from `pg` as a string, not a Date - the `sql<Date>`
   *  type param is a TS-only cast, so it has to be parsed explicitly. */
  familyStartedAt: async (tx: Tx, family: string): Promise<Date | undefined> => {
    const [row] = await tx.select({ min: sql<string | null>`min(${refreshTokens.createdAt})` }).from(refreshTokens).where(eq(refreshTokens.family, family));
    return row?.min ? new Date(row.min) : undefined;
  },
  /** Atomic claim: only flips `used_at` if it is still null, and reports whether it won.
   *  Two concurrent refreshes of the same token race this UPDATE, not a prior SELECT - the
   *  loser's WHERE no longer matches once the winner commits, so it claims zero rows. Answers where
   *  the session stands as the claim found it, not as an earlier read did: a switch of side may have
   *  committed in between. */
  markUsed: (tx: Tx, id: string) =>
    tx.update(refreshTokens).set({ usedAt: new Date() }).where(and(eq(refreshTokens.id, id), isNull(refreshTokens.usedAt))).returning({ desk: refreshTokens.desk, loc: refreshTokens.loc }),
  revokeFamily: (tx: Tx, family: string) => tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.family, family), isNull(refreshTokens.revokedAt))),
  revokeAllForUser: (tx: Tx, userId: string) => tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt))),
  setPassword: (tx: Tx, userId: string, passwordHash: string) => tx.update(users).set({ passwordHash, mustChangePassword: false, updatedAt: new Date() }).where(eq(users.id, userId)),
};

/** How many rows one DELETE of the nightly sweep takes - see purgeRefreshTokens. */
const PURGE_BATCH = 10_000;

/**
 * Nightly housekeeping (cli/purge.ts), a bounded batch at a time. Nothing else ever deletes from
 * this table, so without it every sign-in the hospital ever performs stays on disk for good -
 * and the first run after this ships meets all of them at once. Rows that can no longer authorise
 * anything go: expired ones, and revoked ones past a week's grace, long enough that "why was I
 * signed out on Tuesday?" can still be answered from the row.
 *
 * The loop is what keeps that first run from being a single DELETE holding one transaction and
 * one set of row locks over every session ever opened, against a table every sign-in and every
 * refresh is writing to. `ctid in (select ctid … limit n)` is "any n of the matching rows": ctid
 * is a tuple's physical address, so the delete goes straight at the rows the subquery picked with
 * no second lookup. Note what the subquery is NOT doing - there is no index on `expires_at` or
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
  // statement, so Postgres does re-evaluate it per batch - deliberately left that way: against a
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
