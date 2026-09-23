// Price lists: the flow - transaction, rules, ids. A list stays editable at any time, active or
// not (`savePrice`, in `modules/catalog`); this module owns the list itself - create (always
// cloned from an outlet), delete (only once unattached) and switching which list an outlet is
// active on.
import type { z } from "zod";
import type { Changed, CreatePriceListBodySchema, LocKey, PriceList, SaveOutletPricesBodySchema, WriteResponse } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { auditBefore } from "../../lib/audit.js";
import { isForeignKeyViolation, withTransaction, type Tx } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { allocateId } from "../../lib/ids.js";
import { assertOpen, lockLocation } from "../../lib/locations.js";
import { loadLocations } from "../../lib/master.js";
import { assertRule } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { pricelistsRepo, type GridItemRow, type LockedOutletRow, type OutletRow } from "./repo.js";

export type CreatePriceListBody = z.infer<typeof CreatePriceListBodySchema>;
type SaveOutletPricesBody = z.infer<typeof SaveOutletPricesBodySchema>;

/** "A", "A and B", "A, B and C" - the grid's sentences name every counter they touched. */
const joinNames = (names: string[]) =>
  names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** Only what a till can sell: a bought-in MRP line, a kitchen finished good, a made-to-order dish. */
const SELLABLE: ReadonlySet<string> = new Set(["MRP", "FG", "MTO"]);

const toWire = (row: { id: string; name: string }, outlets: LocKey[]): PriceList => ({ id: row.id, name: row.name, outlets });

/** The outlet's own row, checked the way `addMenuItem` checks it: a real location that is
 *  actually an `Outlet` - the store and the kitchen carry no price list to clone or switch. */
async function loadOutlet(tx: Tx, loc: string): Promise<OutletRow> {
  const row = await pricelistsRepo.outletRow(tx, loc);
  if (!row) throw new NotFoundError(`There is no location ${loc}.`);
  assertRule(row.type === "Outlet", `${row.name} is not an outlet`);
  return row;
}

export function createPricelistsService(db: Db) {
  return {
    /**
     * A new list, cloned from an outlet's current prices or empty.
     *
     * `cloneFrom` is optional on purpose. A hospital that has just opened its first outlet is
     * on no list at all, so there is nothing to clone - and while a source was required, the
     * *first* price list was the one list nobody could create. Named, the source outlet has to
     * be an open outlet that is actually on a list; absent, the list starts with no prices and
     * the manager types them on the outlet's own page.
     *
     * Either way it is created inactive: the manager reviews it, then switches an outlet onto
     * it with `setOutletPriceList`.
     */
    async create(_claims: AccessClaims, body: CreatePriceListBody): Promise<WriteResponse<PriceList>> {
      return withTransaction(db, async (tx) => {
        const name = body.name.trim();
        assertRule(name.length > 0, "Give the price list a name before saving");
        const source = body.cloneFrom === undefined ? null : await loadOutlet(tx, body.cloneFrom);
        if (source) assertRule(source.priceListId, `${source.name} has no price list to clone`);

        const id = await allocateId(tx, "price_list");
        const row = await pricelistsRepo.insert(tx, { id, name });
        if (source?.priceListId) await pricelistsRepo.cloneItems(tx, source.priceListId, id);

        const changed = ["priceLists", "prices"] as const;
        await emitChanged(tx, changed);
        return {
          result: toWire(row, []), changed: [...changed],
          message: source
            ? `${name} created, cloned from ${source.name}'s prices`
            : `${name} created with no prices on it yet - price its products from an outlet's own page`,
        };
      });
    },

    async remove(_claims: AccessClaims, id: string): Promise<WriteResponse<{ id: string }>> {
      return withTransaction(db, async (tx) => {
        // `head` locks this row `FOR UPDATE`; `activate` locks the same row before it can point
        // an outlet at this id, so the two writes serialise rather than race - the FK below is a
        // backstop for any future writer of `locations.price_list_id` that does not take it.
        const row = await pricelistsRepo.head(tx, id);
        if (!row) throw new NotFoundError(`There is no price list ${id}.`);
        const outlets = await pricelistsRepo.outletsOf(tx, id);
        // The list as it stood, in the same shape `create` answers with, before it is gone.
        auditBefore(toWire(row, outlets as LocKey[]));
        if (outlets.length > 0) {
          const locations = await loadLocations(tx);
          const nameOf = (l: string) => locations[l]?.n ?? l;
          assertRule(false, `Refused - ${row.name} is still used by ${outlets.map(nameOf).join(", ")} - switch them to another list first`);
        }
        try {
          await pricelistsRepo.remove(tx, id);
        } catch (e) {
          if (isForeignKeyViolation(e)) assertRule(false, `Refused - ${row.name} is still used by an outlet - switch it to another list first`);
          throw e;
        }
        const changed = ["priceLists"] as const;
        await emitChanged(tx, changed);
        return { result: { id }, changed: [...changed], message: `${row.name} deleted` };
      });
    },

    async activate(_claims: AccessClaims, loc: LocKey, listId: string): Promise<WriteResponse<{ loc: LocKey; listId: string }>> {
      return withTransaction(db, async (tx) => {
        // The outlet's own row, locked `FOR SHARE` like every other write that names a location:
        // switching a closed outlet onto another list would change what it sells the day it
        // reopens, so it is refused the same way a menu add there is.
        const outlet = await lockLocation(tx, loc);
        assertRule(outlet.type === "Outlet", `${outlet.name} is not an outlet`);
        assertOpen(outlet);
        const list = await pricelistsRepo.head(tx, listId);
        if (!list) throw new NotFoundError(`There is no price list ${listId}.`);
        // The outlet's own switch as it stood - the one field this write can change.
        auditBefore({ loc, listId: outlet.priceListId });
        assertRule(outlet.priceListId !== listId, `Nothing to save - ${outlet.name} is already on ${list.name}`);
        await pricelistsRepo.setOutletList(tx, loc, listId);
        const changed = ["priceLists", "prices", "locations"] as const;
        await emitChanged(tx, changed);
        return { result: { loc, listId }, changed: [...changed], message: `${outlet.name} switched to ${list.name}` };
      });
    },
    /**
     * The manager's counter price grid, saved as one batch: each change is one item at one
     * outlet - its price there, whether that till sells it, or both. All or nothing: any refusal
     * names the cell and saves none of it.
     *
     * **One counter's price never moves another's.** Outlets may still share a list (the
     * `setOutletPriceList` era); an outlet this batch reprices is first put on a list of its own -
     * a copy of the shared one, or a new empty one where it had none - and only then priced. The
     * outlets left behind keep the old list exactly as it was. The till goes on reading the
     * outlet's active list (`priceOf`), so nothing on the selling side changes.
     *
     * Lock order is the server's: the outlet rows and the lists they are on (documents), then the
     * new list ids (ids). No balance is touched.
     */
    async saveOutletPrices(_claims: AccessClaims, body: SaveOutletPricesBody): Promise<WriteResponse<{ changes: number; outlets: LocKey[] }>> {
      return withTransaction(db, async (tx) => {
        const changes = body.changes;
        const locKeys = [...new Set(changes.map((c) => c.loc))].sort();
        const outlets = new Map<string, LockedOutletRow>();
        for (const loc of locKeys) {
          const row = await pricelistsRepo.lockOutlet(tx, loc);
          if (!row) throw new NotFoundError(`There is no location ${loc}.`);
          outlets.set(loc, row);
        }
        const itemRows = new Map<string, GridItemRow>((await pricelistsRepo.itemsByKey(tx, [...new Set(changes.map((c) => c.it))])).map((r) => [r.key, r]));
        for (const c of changes) if (!itemRows.has(c.it)) throw new NotFoundError(`There is no item ${c.it}.`);

        const state = new Map<string, { prices: Map<string, number>; menu: Set<string> }>();
        for (const loc of locKeys) {
          const listId = outlets.get(loc)!.priceListId;
          state.set(loc, { prices: listId ? await pricelistsRepo.pricesOn(tx, listId) : new Map(), menu: await pricelistsRepo.menuOf(tx, loc) });
        }
        // Each cell as it stood, in the request's own shape, before any rule is asked.
        auditBefore({
          changes: changes.map((c) => ({ loc: c.loc, it: c.it, price: state.get(c.loc)!.prices.get(c.it) ?? null, listed: state.get(c.loc)!.menu.has(c.it) })),
        });

        for (const loc of locKeys) {
          const row = outlets.get(loc)!;
          assertRule(row.type === "Outlet", `${row.name} is not an outlet`);
          assertOpen(row);
        }
        const seen = new Set<string>();
        let effective = 0;
        for (const c of changes) {
          const item = itemRows.get(c.it)!;
          const outlet = outlets.get(c.loc)!;
          const at = state.get(c.loc)!;
          assertRule(!seen.has(`${c.loc}:${c.it}`), `Refused - ${item.name} at ${outlet.name} is in this save twice`);
          seen.add(`${c.loc}:${c.it}`);
          assertRule(item.active, `Refused - ${item.name} is retired and cannot be priced or sold`);
          assertRule(SELLABLE.has(item.type), `Refused - ${item.name} is ${item.type === "RAW" ? "a raw material" : "packing"} and is never sold at a counter`);
          if (c.price !== undefined) {
            assertRule(c.price > 0, `Enter a price greater than zero for ${item.name} at ${outlet.name}`);
          }
          if (c.listed === true) {
            assertRule((c.price ?? at.prices.get(c.it)) !== undefined, `Refused - give ${item.name} a price at ${outlet.name} before selling it there`);
          }
          if ((c.price !== undefined && c.price !== at.prices.get(c.it)) || (c.listed !== undefined && c.listed !== at.menu.has(c.it))) effective++;
        }
        assertRule(effective > 0, "Nothing to save - every price and switch is already as you set it");

        // Copy-on-write. Every list an outlet being repriced is on is locked first, sorted, so two
        // saves over outlets sharing one list serialise here - the second reads the first's fork.
        const repriced = locKeys.filter((loc) => changes.some((c) => c.loc === loc && c.price !== undefined));
        const heldLists = [...new Set(repriced.map((loc) => outlets.get(loc)!.priceListId).filter((id): id is string => id !== null))].sort();
        const sharers = new Map<string, string[]>();
        for (const id of heldLists) {
          await pricelistsRepo.head(tx, id);
          sharers.set(id, await pricelistsRepo.outletsOf(tx, id));
        }
        const listOf = new Map<string, string>();
        let forked = false;
        for (const loc of repriced) {
          const outlet = outlets.get(loc)!;
          const current = outlet.priceListId;
          const on = current === null ? [] : sharers.get(current)!;
          // The last outlet left on a list keeps it, rather than leaving a copy nobody is on.
          if (current !== null && on.length <= 1) { listOf.set(loc, current); continue; }
          if (current !== null) sharers.set(current, on.filter((l) => l !== loc));
          const id = await allocateId(tx, "price_list");
          await pricelistsRepo.insert(tx, { id, name: `${outlet.name} prices` });
          if (current !== null) await pricelistsRepo.cloneItems(tx, current, id);
          await pricelistsRepo.setOutletList(tx, loc, id);
          listOf.set(loc, id);
          forked = true;
        }

        let priced = false;
        let listed = false;
        for (const c of changes) {
          const at = state.get(c.loc)!;
          if (c.price !== undefined && c.price !== at.prices.get(c.it)) {
            await pricelistsRepo.upsertPrice(tx, listOf.get(c.loc)!, c.it, c.price);
            priced = true;
          }
          if (c.listed === true && !at.menu.has(c.it)) { await pricelistsRepo.listOnMenu(tx, c.loc, c.it); listed = true; }
          if (c.listed === false && at.menu.has(c.it)) { await pricelistsRepo.unlistFromMenu(tx, c.loc, c.it); listed = true; }
        }

        const changed: Changed[] = [
          ...(priced || forked ? ["prices" as const] : []),
          ...(listed ? ["menu" as const] : []),
          ...(forked ? ["priceLists" as const, "locations" as const] : []),
        ];
        await emitChanged(tx, changed);
        const names = locKeys.map((l) => outlets.get(l)!.name);
        return {
          result: { changes: effective, outlets: locKeys as LocKey[] }, changed,
          message: `${effective} ${effective === 1 ? "change" : "changes"} saved at ${joinNames(names)}`,
        };
      });
    },
  };
}
