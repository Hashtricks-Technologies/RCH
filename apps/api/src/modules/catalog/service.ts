// Catalog: the flow — transaction, rules, id. Compose the helpers in apps/api/src/lib/;
// domain rules belong in packages/domain. See modules/_template/service.ts.
import type { Changed, LocKey } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { assertRule } from "../../lib/rules.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { loadItems, loadLocations } from "../../lib/master.js";
import { catalogRepo } from "./repo.js";

type Write<T> = { result: T; changed: Changed[]; message: string };

export function createCatalogService(db: Db) {
  return {
    /** MRP is a hard ceiling (spec §9.2): a priced item that also carries an MRP can never be
     *  sold above the number printed on its own pack. */
    async savePrice(list: "A" | "B", it: string, price: number): Promise<Write<{ list: "A" | "B"; it: string; price: number }>> {
      return withTransaction(db, async (tx) => {
        const item = (await loadItems(tx))[it];
        if (!item) throw new NotFoundError(`There is no item ${it}.`);
        assertRule(!(item.mrp != null && price > item.mrp), `Refused — printed MRP of ₹${item.mrp} is a hard ceiling for ${item.n}`);
        await catalogRepo.upsertPrice(tx, list, it, price);
        // One array for the answer and the announcement, so a till showing the old price is
        // told to refetch exactly what the manager's own screen refetches.
        const changed = ["prices"] as const;
        await emitChanged(tx, changed);
        return { result: { list, it, price }, changed: [...changed], message: `${item.n} priced at ₹${price} on list ${list}` };
      });
    },

    async addMenuItem(loc: LocKey, it: string): Promise<Write<{ loc: LocKey; items: string[] }>> {
      return withTransaction(db, async (tx) => {
        // A location key that fails this lookup never reaches here: LocKeySchema only ever
        // accepts the five seeded keys, so the branch is unreachable, not user-facing.
        const location = (await loadLocations(tx))[loc];
        if (!location) throw new NotFoundError(`There is no location ${loc}.`);
        assertRule(location.type === "Outlet", `${location.n} is not an outlet`);
        const item = (await loadItems(tx))[it];
        if (!item) throw new NotFoundError(`There is no item ${it}.`);
        const listed = await catalogRepo.isListed(tx, loc, it);
        assertRule(!listed, `${item.n} is already listed at ${location.n}`);
        // That check read before the insert took its lock, so two managers adding the same item
        // can both find it unlisted. The insert is the arbiter: it hands the loser no row back,
        // and the loser reads the same refusal the check would have given it a moment later.
        const inserted = await catalogRepo.insertMenuItem(tx, loc, it);
        assertRule(inserted.length > 0, `${item.n} is already listed at ${location.n}`);
        const changed = ["menu"] as const;
        await emitChanged(tx, changed);
        const items = await catalogRepo.menuItems(tx, loc);
        return { result: { loc, items }, changed: [...changed], message: `${item.n} listed at ${location.n}` };
      });
    },

    async removeMenuItem(loc: LocKey, it: string): Promise<Write<{ loc: LocKey; items: string[] }>> {
      return withTransaction(db, async (tx) => {
        const location = (await loadLocations(tx))[loc];
        if (!location) throw new NotFoundError(`There is no location ${loc}.`);
        const item = (await loadItems(tx))[it];
        if (!item) throw new NotFoundError(`There is no item ${it}.`);
        const listed = await catalogRepo.isListed(tx, loc, it);
        assertRule(listed, `${item.n} is not listed at ${location.n}`);
        await catalogRepo.deleteMenuItem(tx, loc, it);
        const changed = ["menu"] as const;
        await emitChanged(tx, changed);
        const items = await catalogRepo.menuItems(tx, loc);
        return { result: { loc, items }, changed: [...changed], message: `${item.n} removed from ${location.n}` };
      });
    },
  };
}
