import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { toWireUser } from "../../lib/wire.js";
import { meRepo } from "./repo.js";

export function createMeService(db: Db) {
  const load = async (id: string) => { const u = await meRepo.byId(db, id); if (!u) throw new NotFoundError("That account no longer exists."); return { user: toWireUser(u), mustChangePassword: u.mustChangePassword }; };
  return {
    get: load,
    async patch(id: string, p: { n?: string; e?: string; ph?: string }) {
      await withTransaction(db, (tx) => meRepo.update(tx, id, { name: p.n, email: p.e, phone: p.ph }));
      return load(id);
    },
  };
}
