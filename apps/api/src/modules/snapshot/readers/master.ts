import { asc, eq } from "drizzle-orm";
import type { PayerKind, PayerRoster, UserMin } from "@rch/contract";
import { locationItems, payers, priceListItems, users } from "../../../db/schema/index.js";
import type { Reader } from "../../../lib/db.js";
import { loadItems, loadLocations, loadRecipes } from "../../../lib/master.js";
import { toWireUserMin } from "../../../lib/wire.js";

/** The item master and the recipes are the same thing the rules read, so they are loaded the same way. */
export const readItems = loadItems;
export const readRecipes = loadRecipes;

/** Every location the hospital has, quarantine included: the store's screens name it, and
 *  `LocationSchema` is keyed by a plain string, so nothing about the wire shape changes. */
export const readLocations = loadLocations;
/** The directory, not a contact list: a colleague's email, employee number and phone are theirs. */
export async function readUsers(db: Reader): Promise<UserMin[]> {
  return (await db.select().from(users).orderBy(asc(users.id))).filter((u) => u.active).map(toWireUserMin);
}
/**
 * Who a bill may be charged to. The till has validated its payer against this table since Phase 3
 * (`posRepo.payer`), while the browser read three arrays out of the fixtures — so a payer added
 * to the database was invisible at the counter and a fixture removed from the browser was still
 * accepted by the server. One table, one list.
 *
 * The reader answers whole, like every other reader here; the cut is `scopeRoster` in `scope.ts`,
 * where every other cut is made. It is not "not scoped" any more: a counter bills every kind of
 * payer and a manager settles the accounts, so those two read the register — but it is a list of
 * every patient on a ward by name and number, and the kitchen, the store and the buyer never
 * open the payer picker at all. They get an empty one.
 */
export async function readRoster(db: Reader): Promise<PayerRoster> {
  const rows = await db.select().from(payers).where(eq(payers.active, true)).orderBy(asc(payers.name));
  const of = (kind: PayerKind) => rows.filter((p) => p.kind === kind).map((p) => ({ kind: p.kind, id: p.id, name: p.name }));
  return { patients: of("patient"), staff: of("staff"), depts: of("dept") };
}
export async function readPrices(db: Reader): Promise<{ A: Record<string, number>; B: Record<string, number> }> {
  const rows = await db.select().from(priceListItems);
  const out = { A: {} as Record<string, number>, B: {} as Record<string, number> };
  for (const r of rows) out[r.list][r.itemKey] = r.price;
  return out;
}
export async function readMenu(db: Reader): Promise<Record<string, string[]>> {
  const rows = await db.select().from(locationItems).orderBy(asc(locationItems.loc), asc(locationItems.seq));
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.loc] ??= []).push(r.itemKey);
  return out;
}
