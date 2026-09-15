// Price lists: the flow - transaction, rules, ids. A list stays editable at any time, active or
// not (`savePrice`, in `modules/catalog`); this module owns the list itself - create (always
// cloned from an outlet), delete (only once unattached) and switching which list an outlet is
// active on.
import type { z } from "zod";
import type { CreatePriceListBodySchema, LocKey, PriceList, WriteResponse } from "@rch/contract";
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
import { pricelistsRepo, type OutletRow } from "./repo.js";

export type CreatePriceListBody = z.infer<typeof CreatePriceListBodySchema>;

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
    async create(_claims: AccessClaims, body: CreatePriceListBody): Promise<WriteResponse<PriceList>> {
      return withTransaction(db, async (tx) => {
        const name = body.name.trim();
        assertRule(name.length > 0, "Give the price list a name before saving");
        const source = await loadOutlet(tx, body.cloneFrom);
        assertRule(source.priceListId, `${source.name} has no price list to clone`);

        const id = await allocateId(tx, "price_list");
        const row = await pricelistsRepo.insert(tx, { id, name });
        await pricelistsRepo.cloneItems(tx, source.priceListId, id);

        // Cloning never activates it anywhere - the manager reviews it, then switches an
        // outlet on with `setOutletPriceList`.
        const changed = ["priceLists", "prices"] as const;
        await emitChanged(tx, changed);
        return { result: toWire(row, []), changed: [...changed], message: `${name} created, cloned from ${source.name}'s prices` };
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
  };
}
