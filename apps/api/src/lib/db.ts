import type { Db } from "../db/client.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** All writes go through here so a service cannot forget the transaction. */
export const withTransaction = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> => db.transaction(fn);
