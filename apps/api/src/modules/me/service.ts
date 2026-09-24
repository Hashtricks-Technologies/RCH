import type { Db } from "../../db/client.js";
import { withTransaction, type Reader } from "../../lib/db.js";
import { auditBefore } from "../../lib/audit.js";
import { NotFoundError } from "../../lib/errors.js";
import { toWireUser } from "../../lib/wire.js";
import { loadAccess } from "../../lib/access.js";
import { meRepo } from "./repo.js";

export function createMeService(db: Db) {
  /** `loc` is the counter this session is standing at, not the account's home: a consultant
   *  posted to several works a shift at one of them, and the token is what says which. Passed in
   *  rather than read off the row, so `/me` agrees with the token that asked for it. */
  const load = async (reader: Reader, id: string, loc?: string) => {
    const u = await meRepo.byId(reader, id);
    if (!u) throw new NotFoundError("That account no longer exists.");
    return { user: { ...toWireUser(u, await loadAccess(reader, u.id)), ...(loc ? { loc } : {}) }, mustChangePassword: u.mustChangePassword };
  };
  return {
    get: (id: string, loc?: string) => load(db, id, loc),
    /** The re-read is inside the transaction, so the response this write answers with is the
     *  one its own claim row records before COMMIT (`lib/db.ts`). Read back after committing,
     *  it was the one response in the system built where no transaction could record it. */
    async patch(id: string, p: { n?: string; e?: string; ph?: string }) {
      return withTransaction(db, async (tx) => {
        // The same `{ user, mustChangePassword }` this write answers with, read before it changes.
        auditBefore(await load(tx, id));
        await meRepo.update(tx, id, { name: p.n, email: p.e, phone: p.ph });
        return load(tx, id);
      });
    },
  };
}
