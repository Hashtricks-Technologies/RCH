// Catalog: the flow - transaction, rules, id. Compose the helpers in apps/api/src/lib/;
// domain rules belong in packages/domain. See modules/_template/service.ts.
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { Changed, CreateItemBodySchema, Item, LocKey, PatchItemBodySchema } from "@rch/contract";
import {
  checkPhoto, fq, imageNoneMessage, imageOffMenuMessage, imageRetiredMessage,
  mrpBelowShelfPrice, round3, unauthorisedItemFields, type ItemField,
} from "@rch/domain";
import type { Db } from "../../db/client.js";
import { isForeignKeyViolation, withTransaction } from "../../lib/db.js";
import { auditBefore } from "../../lib/audit.js";
import { assertRule } from "../../lib/rules.js";
import { ForbiddenError, NotFoundError, NotReadyError, RuleError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { imageKey, type ImageStore, type StoredImage } from "../../lib/images.js";
import { postMoves } from "../../lib/ledger.js";
import { assertOpen, lockLocation } from "../../lib/locations.js";
import { loadItems, loadLocations } from "../../lib/master.js";
import { toWireItem } from "../../lib/wire.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { catalogRepo, type ItemPatch } from "./repo.js";

export type CreateItemBody = z.infer<typeof CreateItemBodySchema>;
export type PatchItemBody = z.infer<typeof PatchItemBodySchema>;

type Write<T> = { result: T; changed: Changed[]; message: string };

// ---- item patch ----
/** The two halves of the master, in the words of the desk that owns each (`ITEM_FIELD_ROLES`,
 *  `@rch/domain`). An operator who reached for the wrong box is told **whose** box it is, which
 *  is what they actually need - a per-field list would only repeat what the greyed-out input on
 *  their own screen already showed them. */
const COMMERCIAL_REFUSAL = "Only the outlet manager changes an item's price, cost or GST - ask them to make that change";
const OPERATIONAL_REFUSAL = "The store, the buyer and the kitchen keep an item's name, group, HSN, reorder level, shelf life and stock-request source - ask one of them";
/** `active` is the one field every desk but the counter owns, so it never lands in a refusal;
 *  everything else is the manager's or the three desks', and nothing is in neither. */
const COMMERCIAL: readonly ItemField[] = ["mrp", "cost", "gst"];

// ---- item photos ----
export type ReadImage = { found: true; photo: StoredImage } | { found: false; missingObject: boolean };
const HASH = /^[0-9a-f]{64}$/;

/** The photo rules, asked once before any byte is stored (so a refusal leaves nothing behind) and
 *  again under the item's own lock (so a retirement or a delisting that lands in between still
 *  wins). A counter's scope is its outlet's menu; the manager is hospital-wide. */
function assertPhotoRules(claims: AccessClaims, t: { name: string; active: boolean; listed: boolean }, outlet: string, setting: boolean): void {
  if (setting) assertRule(t.active, imageRetiredMessage(t.name));
  if (claims.role === "counter" && !t.listed) throw new ForbiddenError(imageOffMenuMessage(t.name, outlet));
}

export function createCatalogService(db: Db, images: ImageStore) {
  return {
    /**
     * A new line on the item master.
     *
     * The key is slugged from the name and de-duplicated with a numeric suffix, exactly as the
     * store keeper's screen has always done it. Two different names can slug the same way, and
     * the suffix scan reads before the insert takes its lock, so the scan runs under an advisory
     * lock on the slug - the device the staff-credit sum already uses. The **name** clash is a
     * different question and is decided by `items_name_ci_uq`: the pre-check reads, the insert
     * arbitrates, and the loser reads the store's own sentence.
     */
    async createItem(claims: AccessClaims, body: CreateItemBody): Promise<Write<{ key: string; item: Item }>> {
      return withTransaction(db, async (tx) => {
        const name = body.name.trim();
        assertRule(name.length > 0, "Give the product a name");
        assertRule(body.cost > 0, "Cost must be more than zero");
        // Location decides which rows. The kitchen books what it makes at the kitchen;
        // the store keeper and the buyer book at the central store. Derived from the caller's
        // role, not their loc - the two happen to agree today (see the task brief).
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
          shelfLifeHours: body.sl && body.sl > 0 ? body.sl : null,
          src: body.src ?? null,
          active: true, createdAt: at, updatedAt: at,
        });
        assertRule(row, `${name} is already in the catalogue`);

        const opening = round3(body.opening);
        // A move of zero is not a movement, and a balance row's presence means "this location
        // carries the line" (M12) - a product nobody has bought yet carries nowhere.
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

    // ---- item patch ----
    /**
     * An existing line on the item master, edited or retired.
     *
     * `POST /items` used to be the only write the master had: a mis-typed MRP, a wrong HSN or a
     * product the hospital stopped carrying stayed on every screen forever. This is the way
     * back, and it is one endpoint with two permissions - `ITEM_FIELD_ROLES` (`@rch/domain`) is
     * the whole of that split, and the drawer disables the same boxes this refuses.
     *
     * The order below is the order the operator would check it in themselves, and the order the
     * tests pin: whose item, is there anything to change, is it yours to change, is each new
     * value a legal one, and only then - for a retirement - is the line actually finished with.
     * **Stock is asked about before menus**: an item with stock on a shelf *and* a menu line has
     * to hear about the stock, because writing it off is the thing that takes longest.
     *
     * No balance lock is taken and none is needed: nothing here moves, promises or reads against
     * a balance. `balancesOf` is a plain read, and a retirement that races a sale is the same
     * race a price change has always had - the sale's own cover check under its own locks is
     * what decides it.
     */
    async patchItem(claims: AccessClaims, it: string, body: PatchItemBody): Promise<Write<{ key: string; item: Item }>> {
      return withTransaction(db, async (tx) => {
        const row = await catalogRepo.head(tx, it);
        // The same sentence `savePrice` gives, word for word: one missing item, one wording.
        if (!row) throw new NotFoundError(`There is no item ${it}.`);
        // The line as the locked row has it, in the `{ key, item }` shape this write answers with,
        // so the audit drawer can set the two side by side.
        auditBefore({ key: it, item: toWireItem(row) });

        const keys = Object.keys(body) as ItemField[];
        assertRule(keys.length > 0, `Nothing to change on ${row.name}`);

        const notYours = unauthorisedItemFields(claims.role, keys);
        assertRule(
          notYours.length === 0,
          notYours.some((f) => COMMERCIAL.includes(f)) ? COMMERCIAL_REFUSAL : OPERATIONAL_REFUSAL,
        );

        const patch: ItemPatch = {};
        // The name the operator will read in every sentence below - the new one when they are
        // renaming, so a refusal is about the product as they have just written it.
        let name = row.name;
        if (body.n !== undefined) {
          name = body.n.trim();
          assertRule(name.length > 0, "Give the product a name");
          // The pre-check gives the sentence; `items_name_ci_uq` on the UPDATE is the arbiter
          // (`addMenuItem`'s pattern). A case-only rename of the item's own name is not a clash.
          assertRule(!(await catalogRepo.nameTaken(tx, name, it)), `${name} is already in the catalogue`);
          patch.name = name;
        }
        if (body.cost !== undefined) {
          assertRule(body.cost > 0, "Cost must be more than zero");
          patch.cost = body.cost;
        }
        if (body.mrp !== undefined) {
          // **There is no clearing door.** An item that carries a printed MRP keeps one: the
          // number is the system's one hard ceiling (`priceOf`, `PUT /prices/:list/:it`) and the
          // floor a goods receipt judges a delivery against, and a blanked box would take both
          // away with nothing on the record to say it happened. A zero is what an empty input
          // sends, which is exactly why it cannot be the way through - the drawer omits `mrp`
          // altogether rather than sending one.
          assertRule(body.mrp > 0, "Give the printed MRP a value - an item that carries one keeps it");
          const prices = await catalogRepo.pricesOf(tx, it);
          const shelf = prices.reduce((hi, p) => Math.max(hi, p.price), 0);
          const refusal = mrpBelowShelfPrice(name, body.mrp, shelf);
          assertRule(!refusal, refusal ?? "");
          patch.mrp = body.mrp;
        }
        if (body.gst !== undefined) patch.gst = body.gst;
        // `QtySchema` carries no minimum - a zero has to reach the operator as a sentence, not a
        // 400 - so the one figure here that cannot go below zero says so itself.
        if (body.rl !== undefined) {
          assertRule(body.rl >= 0, "Reorder level cannot be negative");
          patch.reorderLevel = round3(body.rl);
        }
        // A blank box falls back to the same defaults `createItem` applies, rather than leaving
        // an item with no HSN code to put on a bill or no group for a picker to sort it under.
        if (body.hsn !== undefined) patch.hsn = body.hsn.trim() || "2106";
        if (body.grp !== undefined) patch.grp = body.grp.trim() || "Other";
        // Same reading `createItem` gives a blank shelf-life box: 0, like absent, means the
        // item carries no best-before at all, not a batch due the instant it is made.
        if (body.sl !== undefined) patch.shelfLifeHours = body.sl > 0 ? body.sl : null;
        if (body.src !== undefined) patch.src = body.src;

        // Only a line actually **crossing** off the catalogue has to be clear of stock and
        // menus; asking it again of one already retired would refuse a no-op over stock that
        // arrived after it left, which is a question for whoever booked that stock in.
        if (body.active === false && row.active) {
          const locations = await loadLocations(tx);
          const nameOf = (l: string) => locations[l]?.n ?? l;
          const held = await catalogRepo.balancesOf(tx, it);
          assertRule(held.length === 0, `${name} still has stock at ${held.map(nameOf).join(", ")} - write it off before retiring it`);
          const listed = await catalogRepo.menusOf(tx, it);
          assertRule(listed.length === 0, `${name} is still listed at ${listed.map(nameOf).join(", ")} - take it off those menus before retiring it`);
        }
        if (body.active !== undefined) patch.active = body.active;

        const updated = await catalogRepo.update(tx, it, patch);
        assertRule(updated, `${name} is already in the catalogue`);

        const at = new Date();
        // "Retired" and "Restored" describe a line **crossing** - compared against the row this
        // write locked, not against what the patch asked for. A patch that sets `active: true`
        // on a line that was already live has restored nothing, and a trail saying it did, or a
        // toast reading "back in the catalogue" for a product that never left, is a false record
        // of an event that did not happen. Either way the other fields still landed, so it reads
        // as the ordinary "Updated" rather than as nothing at all.
        const crossed = body.active !== undefined && body.active !== row.active;
        const word = !crossed ? "Updated" : body.active === false ? "Retired" : "Restored";
        await appendHistory(tx, "item", it, word, claims.sub, at);
        const changed = ["items"] as const;
        await emitChanged(tx, changed);
        return {
          result: { key: it, item: toWireItem(updated) },
          changed: [...changed],
          message: word === "Retired"
            ? `${updated.name} retired - it stays on past documents and cannot be sold or ordered again`
            : word === "Restored"
              ? `${updated.name} is back in the catalogue`
              : `${updated.name} updated`,
        };
      });
    },

    // ---- item photos ----
    /**
     * Put a photo on an item, or replace the one it has.
     *
     * The bytes go to the image store **before** the transaction: the key is the photo's own
     * hash, so a retry or two identical uploads write the same object, and a transaction that
     * then refuses leaves at most a few KB nobody points at. Only once the row points at the new
     * hash is the old object deleted - best effort, since the bucket keeps old versions anyway.
     */
    async setItemImage(claims: AccessClaims, it: string, data: string): Promise<Write<{ key: string; item: Item }>> {
      const bytes = new Uint8Array(Buffer.from(data, "base64"));
      const check = checkPhoto(bytes);
      if (!check.ok) throw new RuleError(check.refusal);
      const outlet = (await loadLocations(db))[claims.loc]?.n ?? claims.loc;
      const target = await catalogRepo.photoTarget(db, it, claims.loc);
      if (!target) throw new NotFoundError(`There is no item ${it}.`);
      assertPhotoRules(claims, target, outlet, true);

      const hash = createHash("sha256").update(bytes).digest("hex");
      try {
        await images.put(imageKey(it, hash), bytes, check.type);
      } catch (cause) {
        throw new NotReadyError("The photo could not be stored just now - try again", cause);
      }

      let previous: string | null = null;
      const out = await withTransaction(db, async (tx) => {
        const row = await catalogRepo.head(tx, it);
        if (!row) throw new NotFoundError(`There is no item ${it}.`);
        auditBefore({ key: it, item: toWireItem(row) });
        assertPhotoRules(claims, { name: row.name, active: row.active, listed: await catalogRepo.isListed(tx, claims.loc, it) }, outlet, true);
        previous = row.image;
        const updated = await catalogRepo.setImage(tx, it, hash);
        await appendHistory(tx, "item", it, "Updated", claims.sub, new Date());
        const changed = ["items"] as const;
        await emitChanged(tx, changed);
        return { result: { key: it, item: toWireItem(updated) }, changed: [...changed], message: `Photo saved for ${updated.name}` };
      });
      if (previous && previous !== hash) await images.delete(imageKey(it, previous)).catch(() => undefined);
      return out;
    },

    /** Take an item's photo off. Allowed on a retired item - a photo is the one thing about a
     *  retired line anybody would still want to tidy away. */
    async removeItemImage(claims: AccessClaims, it: string): Promise<Write<{ key: string; item: Item }>> {
      const outlet = (await loadLocations(db))[claims.loc]?.n ?? claims.loc;
      let previous: string | null = null;
      const out = await withTransaction(db, async (tx) => {
        const row = await catalogRepo.head(tx, it);
        if (!row) throw new NotFoundError(`There is no item ${it}.`);
        auditBefore({ key: it, item: toWireItem(row) });
        assertPhotoRules(claims, { name: row.name, active: row.active, listed: await catalogRepo.isListed(tx, claims.loc, it) }, outlet, false);
        assertRule(row.image, imageNoneMessage(row.name));
        previous = row.image;
        const updated = await catalogRepo.setImage(tx, it, null);
        await appendHistory(tx, "item", it, "Updated", claims.sub, new Date());
        const changed = ["items"] as const;
        await emitChanged(tx, changed);
        return { result: { key: it, item: toWireItem(updated) }, changed: [...changed], message: `Photo removed from ${updated.name}` };
      });
      if (previous) await images.delete(imageKey(it, previous)).catch(() => undefined);
      return out;
    },

    /** The bytes behind `GET /items/:it/image/:hash` - only for the hash the item points at now. */
    async readItemImage(it: string, hash: string): Promise<ReadImage> {
      if (!HASH.test(hash) || (await catalogRepo.imageOf(db, it)) !== hash) return { found: false, missingObject: false };
      const photo = await images.get(imageKey(it, hash));
      return photo ? { found: true, photo } : { found: false, missingObject: true };
    },

    /** MRP is a hard ceiling: a priced item that also carries an MRP can never be
     *  sold above the number printed on its own pack. */
    async savePrice(list: string, it: string, price: number): Promise<Write<{ list: string; it: string; price: number }>> {
      return withTransaction(db, async (tx) => {
        const item = (await loadItems(tx))[it];
        if (!item) throw new NotFoundError(`There is no item ${it}.`);
        if (!(await catalogRepo.priceListExists(tx, list))) throw new NotFoundError(`There is no price list ${list}.`);
        // `null` where this list has never priced the item: the upsert below inserts rather than changes.
        const prior = (await catalogRepo.pricesOf(tx, it)).find((p) => p.list === list);
        auditBefore({ list, it, price: prior?.price ?? null });
        assertRule(!(item.mrp != null && price > item.mrp), `Refused - printed MRP of ₹${item.mrp} is a hard ceiling for ${item.n}`);
        // The check above ran unlocked; a list deleted between it and this insert - legal, since
        // a list stays editable whether or not it is active anywhere - surfaces as this same
        // foreign-key violation, caught the way `deleteUserTx` catches its own race.
        try {
          await catalogRepo.upsertPrice(tx, list, it, price);
        } catch (e) {
          if (isForeignKeyViolation(e)) throw new NotFoundError(`There is no price list ${list}.`);
          throw e;
        }
        // One array for the answer and the announcement, so a till showing the old price is
        // told to refetch exactly what the manager's own screen refetches.
        const changed = ["prices"] as const;
        await emitChanged(tx, changed);
        return { result: { list, it, price }, changed: [...changed], message: `${item.n} priced at ₹${price} on list ${list}` };
      });
    },

    async addMenuItem(loc: LocKey, it: string): Promise<Write<{ loc: LocKey; items: string[] }>> {
      return withTransaction(db, async (tx) => {
        const location = await lockLocation(tx, loc);
        assertRule(location.type === "Outlet", `${location.name} is not an outlet`);
        assertOpen(location);
        const item = (await loadItems(tx))[it];
        if (!item) throw new NotFoundError(`There is no item ${it}.`);
        auditBefore({ loc, items: await catalogRepo.menuItems(tx, loc) });
        const listed = await catalogRepo.isListed(tx, loc, it);
        assertRule(!listed, `${item.n} is already listed at ${location.name}`);
        // That check read before the insert took its lock, so two managers adding the same item
        // can both find it unlisted. The insert is the arbiter: it hands the loser no row back,
        // and the loser reads the same refusal the check would have given it a moment later.
        const inserted = await catalogRepo.insertMenuItem(tx, loc, it);
        assertRule(inserted.length > 0, `${item.n} is already listed at ${location.name}`);
        const changed = ["menu"] as const;
        await emitChanged(tx, changed);
        const items = await catalogRepo.menuItems(tx, loc);
        return { result: { loc, items }, changed: [...changed], message: `${item.n} listed at ${location.name}` };
      });
    },

    async removeMenuItem(loc: LocKey, it: string): Promise<Write<{ loc: LocKey; items: string[] }>> {
      return withTransaction(db, async (tx) => {
        const location = (await loadLocations(tx))[loc];
        if (!location) throw new NotFoundError(`There is no location ${loc}.`);
        const item = (await loadItems(tx))[it];
        if (!item) throw new NotFoundError(`There is no item ${it}.`);
        auditBefore({ loc, items: await catalogRepo.menuItems(tx, loc) });
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
