import type { Db } from "../db/client.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** The pool or an open transaction's client; both answer `select`. */
export type Reader = Db | Tx;

/**
 * A read that makes more than one query runs here, so one request holds one connection, and it
 * awaits its queries in sequence - a transaction is a single client and runs one query at a time
 * (apps/api/src/lib/db.ts, "Reads" in apps/api/CLAUDE.md). `read only` also means a reader that
 * ever tried to write would be refused by Postgres.
 */
export const withReadTransaction = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  db.transaction(fn, { accessMode: "read only" });
