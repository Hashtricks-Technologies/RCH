import type { Db } from "../../db/client.js";
import { withTransaction, type Reader } from "../../lib/db.js";
import { auditBefore } from "../../lib/audit.js";
import { NotFoundError } from "../../lib/errors.js";
import { wireUserAt } from "../../lib/standing.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { meRepo } from "./repo.js";

export function createMeService(db: Db) {
  /** Where this session is standing - its counter, and a two-sided role's side - not the account's
   *  home: the token is what says, so `/me` agrees with the token that asked for it. */
  const load = async (reader: Reader, claims: AccessClaims) => {
    const u = await meRepo.byId(reader, claims.sub);
    if (!u) throw new NotFoundError("That account no longer exists.");
    return { user: await wireUserAt(reader, u, claims), mustChangePassword: u.mustChangePassword };
  };
  return {
    get: (claims: AccessClaims) => load(db, claims),
    /** The re-read is inside the transaction, so the response this write answers with is the
     *  one its own claim row records before COMMIT (`lib/db.ts`). Read back after committing,
     *  it was the one response in the system built where no transaction could record it. */
    async patch(claims: AccessClaims, p: { n?: string; e?: string; ph?: string }) {
      return withTransaction(db, async (tx) => {
        // The same `{ user, mustChangePassword }` this write answers with, read before it changes.
        auditBefore(await load(tx, claims));
        await meRepo.update(tx, claims.sub, { name: p.n, email: p.e, phone: p.ph });
        return load(tx, claims);
      });
    },
  };
}
