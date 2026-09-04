import type { Db } from "../db/client.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A read may be handed the pool or an open transaction's own client; both answer `select`.
 *  Every reader and read-side repo takes this rather than `Db`, so the same function serves a
 *  standalone GET and a write validating against the master it is about to commit with. */
export type Reader = Db | Tx;

/** All writes go through here so a service cannot forget the transaction. */
export const withTransaction = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> => db.transaction(fn);

/**
 * Every read that makes more than one query goes through here, so **one request takes one
 * connection**.
 *
 * `pg` checks a client out per query, so a read that fans out with `Promise.all` asks the pool
 * for one connection *per reader*: `GET /snapshot`'s twenty-four readers wanted about forty at
 * once, against a pool of ten. Thirty concurrent snapshots therefore queued hundreds of
 * acquisitions behind ten connections and p95 went to 2.9 s with `pg_pool_idle` pinned at 0 —
 * measured, not guessed (RUNBOOK §12). A transaction holds exactly one client from `begin` to
 * `commit`, so the fan-out costs one connection however many queries it makes.
 *
 * `read only` is the honest declaration and also a guard: a reader that ever tried to write
 * would be refused by Postgres rather than quietly committing from a GET.
 *
 * Callers inside one of these `await` their queries **one after another** rather than wrapping
 * them in `Promise.all`. A transaction is a single client and a client runs one query at a
 * time, so `Promise.all` buys no parallelism here — `pg` queues the second query today and
 * will refuse it in pg 9 (the same note `lib/master.ts` has carried since Phase 2). Sequential
 * awaits say what actually happens.
 */
export const withReadTransaction = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  db.transaction(fn, { accessMode: "read only" });

/** Postgres reports a unique violation the same way whether the arbiter is a table constraint
 *  or (as for a partial unique index) a unique index — `code` 23505, `constraint` the index's
 *  own name. Drizzle wraps the raw `pg` error in a `DrizzleQueryError` and carries it as
 *  `.cause`, so that is where the code and constraint name are read from. `UPDATE` has no
 *  `onConflictDoNothing`, so this is how a repo makes a rename or a reactivation raced by a
 *  second writer resolve into a refusal instead of a 500 — one home for both callers
 *  (`modules/vendors/repo.ts`, `modules/contracts/repo.ts`). */
export const isUniqueViolation = (err: unknown, constraint: string): boolean => {
  const cause = (err as { cause?: unknown } | null)?.cause as { code?: string; constraint?: string } | undefined;
  return cause?.code === "23505" && cause?.constraint === constraint;
};
