// Catalog: the flow — transaction, rules, id. Compose the helpers in apps/api/src/lib/;
// domain rules belong in packages/domain. See modules/_template/service.ts.
import type { z } from "zod";
import type { Changed, CreateItemBodySchema, Item, LocKey } from "@rch/contract";
import { fq, round3 } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { assertRule } from "../../lib/rules.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { postMoves } from "../../lib/ledger.js";
import { loadItems, loadLocations } from "../../lib/master.js";
import { toWireItem } from "../../lib/wire.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { catalogRepo } from "./repo.js";

export type CreateItemBody = z.infer<typeof CreateItemBodySchema>;

type Write<T> = { result: T; changed: Changed[]; message: string };

export function createCatalogService(db: Db) {
  return {
    /**
     * A new line on the item master.
     *
     * The key is slugged from the name and de-duplicated with a numeric suffix, exactly as the
     * store keeper's screen has always done it. Two different names can slug the same way, and
     * the suffix scan reads before the insert takes its lock, so the scan runs under an advisory
     * lock on the slug — the device the staff-credit sum already uses. The **name** clash is a
     * different question and is decided by `items_name_ci_uq`: the pre-check reads, the insert
     * arbitrates, and the loser reads the store's own sentence.
     */
    async createItem(claims: AccessClaims, body: CreateItemBody): Promise<Write<{ key: string; item: Item }>> {
      return withTransaction(db, async (tx) => {
        const name = body.name.trim();
        assertRule(name.length > 0, "Give the product a name");
        assertRule(body.cost > 0, "Cost must be more than zero");
        // §8.3: location decides which rows. The kitchen books what it makes at the kitchen;
        // the store keeper and the buyer book at the central store. Derived from the caller's
        // role, not their loc — the two happen to agree today (see the task brief).
        const allowed: LocKey = claims.role === "prod" ? "kitchen" : "store";
        const locations = await loadLocations(tx);
        assertRule(body.loc === allowed, `A new product's opening stock is booked at ${locations[allowed]?.n ?? allowed}`);

        const slug = body.key.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "item";
        await catalogRepo.lockSlug(tx, slug);
        const taken = await catalogRepo.keysLike(tx, slug);
        let key = slug;
        for (let n = 2; taken.has(key); n += 1) key = `${slug}${n}`;

        const at = new Date();
        const row = await catalogRepo.insertItem(tx, {
          key, code: body.code.trim() || key.toUpperCase(), name, unit: body.unit || "nos",
          type: body.type, grp: body.grp.trim() || "Other", hsn: body.hsn.trim() || "2106",
          gst: body.gst, reorderLevel: round3(body.reorder), cost: body.cost,
          mrp: body.mrp && body.mrp > 0 ? body.mrp : null,
          shelfLifeHours: body.sl && body.sl > 0 ? body.sl : null, active: true, createdAt: at, updatedAt: at,
        });
        assertRule(row, `${name} is already in the catalogue`);

        const opening = round3(body.opening);
        // A move of zero is not a movement, and a balance row's presence means "this location
        // carries the line" (M12) — a product nobody has bought yet carries nowhere.
        if (opening > 0) {
          await postMoves(tx, [{ loc: body.loc, it: key, qty: opening, kind: "opening", refType: "item", refId: key, by: claims.sub, at }]);
        }
        const changed = (opening > 0 ? ["items", "stock"] : ["items"]) as Changed[];
        await emitChanged(tx, changed);
        const item = toWireItem(row);
        return {
          result: { key, item }, changed,
          message: opening > 0
            ? `${name} added to the catalogue with ${fq(opening, item.u)} ${item.u} at ${locations[body.loc]?.n ?? body.loc}`
            : `${name} added to the catalogue`,
        };
      });
    },

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
