import type { Db } from "../db/client.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** All writes go through here so a service cannot forget the transaction. */
export const withTransaction = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> => db.transaction(fn);

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
