import { asc, eq } from "drizzle-orm";
import type { Item, LocKey, PayerKind, PayerRoster, PriceList, UserMin } from "@rch/contract";
import { items, locationItems, locations, payers, priceListItems, priceLists, users } from "../../../db/schema/index.js";
import type { Reader } from "../../../lib/db.js";
import { loadLocations } from "../../../lib/master.js";
import { toWireItem, toWireUserMin } from "../../../lib/wire.js";

// ---- item patch ----
/**
 * The **whole** item master, retired lines included, each carrying its own `active`.
 *
 * This is the one place the wire and the rules deliberately part company. `loadItems`
 * (`lib/master.ts`) leaves a retired item out, because no rule may price, promise or bill
 * something the master no longer sells. A *screen* has the opposite need: a bill, a ticket or a
 * purchase order raised months ago still names the item, and a reader that dropped it would
 * leave the operator reading a raw key where a product name belongs. So the registry carries
 * everything and the pickers filter - `activeItems()` in `UI/src/lib/selectors.ts`.
 */
export const readItems = async (db: Reader): Promise<Record<string, Item>> =>
  Object.fromEntries((await db.select().from(items).orderBy(asc(items.key))).map((r) => [r.key, toWireItem(r)]));

/** Every location the hospital has, quarantine included: the store's screens name it, and
 *  `LocationSchema` is keyed by a plain string, so nothing about the wire shape changes. */
export const readLocations = loadLocations;
/** The directory, not a contact list: a colleague's email, employee number and phone are theirs. */
export async function readUsers(db: Reader): Promise<UserMin[]> {
  return (await db.select().from(users).orderBy(asc(users.id))).filter((u) => u.active).map(toWireUserMin);
}
/**
 * Who a bill may be charged to. The till has validated its payer against this table since Phase 3
 * (`posRepo.payer`), while the browser read three arrays out of the fixtures - so a payer added
 * to the database was invisible at the counter and a fixture removed from the browser was still
 * accepted by the server. One table, one list.
 *
 * The reader answers whole, like every other reader here; the cut is `scopeRoster` in `scope.ts`,
 * where every other cut is made. It is not "not scoped" any more: a counter bills every kind of
 * payer and a manager settles the accounts, so those two read the register - but it is a list of
 * every patient on a ward by name and number, and the kitchen, the store and the buyer never
 * open the payer picker at all. They get an empty one.
 */
export async function readRoster(db: Reader): Promise<PayerRoster> {
  const rows = await db.select().from(payers).where(eq(payers.active, true)).orderBy(asc(payers.name));
  const of = (kind: PayerKind) => rows.filter((p) => p.kind === kind).map((p) => ({ kind: p.kind, id: p.id, name: p.name }));
  return { patients: of("patient"), staff: of("staff"), depts: of("dept"), doctors: of("doctor") };
}
export async function readPrices(db: Reader): Promise<Record<string, Record<string, number>>> {
  const rows = await db.select().from(priceListItems);
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.listId] ??= {})[r.itemKey] = r.price;
  return out;
}
/** The lists themselves, named, with the outlets currently active on each - derived from
 *  `locations.price_list_id` rather than stored, so it can never drift from what a switch
 *  actually did. */
export async function readPriceLists(db: Reader): Promise<PriceList[]> {
  const lists = await db.select().from(priceLists).orderBy(asc(priceLists.id));
  const locs = await db.select({ key: locations.key, listId: locations.priceListId }).from(locations).orderBy(asc(locations.key));
  const outletsOf = (id: string) => locs.filter((l) => l.listId === id).map((l) => l.key as LocKey);
  return lists.map((l) => ({ id: l.id, name: l.name, outlets: outletsOf(l.id) }));
}
export async function readMenu(db: Reader): Promise<Record<string, string[]>> {
  const rows = await db.select().from(locationItems).orderBy(asc(locationItems.loc), asc(locationItems.seq));
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.loc] ??= []).push(r.itemKey);
  return out;
}
