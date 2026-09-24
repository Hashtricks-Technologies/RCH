import { atOutlet, DESK_DEFAULTS, readsHospitalWide } from "@rch/domain";
import type { ClassTerms, Item, Location, Payer, PayerRoster, PayerTerms, Permissions, PriceList, Terms, UserMin } from "../types";

// `STAFF_CREDIT_LIMIT` is deliberately not among these any more: the till reads the ceiling off
// `GET /reports/credit/:kind/:id` (`credit.limit`), because the number that matters is the one
// the server will refuse on, not a constant compiled into the bundle.
export { PO_APPROVAL_LIMIT } from "@rch/contract";

// Registries. Mutable on purpose: the store can add a product, and hydrateMaster()
// replaces the contents with what the server returns. Screens import these directly,
// so they must keep their identity - assign into them, never reassign them.
//
// They start **empty**. Nothing here is data: the app renders no screen until `auth` reaches
// "ready", which only a snapshot can do, and the snapshot is what fills every one of them.
// The demo hospital lives in `@rch/contract/fixtures` and is imported by tests alone.
export const LOC: Record<string, Location> = {};
export const IT: Record<string, Item> = {};
export const PL: Record<string, Record<string, number>> = {};
/** The price lists themselves - name and which outlets are on each - keyed by id, alongside
 *  `PL`'s flat item->price maps. Filled by `hydratePriceLists`. */
export const PRICE_LISTS: Record<string, PriceList> = {};
export const MENU: Record<string, string[]> = {};
/** The directory the server sends: a name badge each. Nobody's contact details but your own
 *  travel over the wire, so this is `UserMin`, not `User` - the signed-in person's own full
 *  record lives in the store's `user`. */
export const USERS: UserMin[] = [];

/** Who a bill may be charged to. Mutable registries like IT and LOC, for the same reason: the
 *  counter's screen imports them directly, so they must keep their identity - assign into them,
 *  never reassign them. Filled by `hydrateRoster` from the snapshot's `roster`, which the server
 *  reads out of the `payers` table it has been validating the till against since Phase 3. */
export const STAFF: Payer[] = [];
export const DEPTS: Payer[] = [];
export const DOCTORS: Payer[] = [];
export function hydrateRoster(r: PayerRoster): void {
  STAFF.splice(0, STAFF.length, ...r.staff);
  DEPTS.splice(0, DEPTS.length, ...r.depts);
  DOCTORS.splice(0, DOCTORS.length, ...r.doctors);
}

/**
 * And what each of them is charged: the rate card, keyed the way the server keys it.
 *
 * A registry like the rest, replaced in place, because the till reads it while a bill is being
 * taken and the manager's Credit screen edits it. It is a **preview** wherever the till reads
 * it: the server resolves the rate again inside the sale's own transaction and that is the rate
 * the bill is actually priced at (root CLAUDE.md, *Nothing is previewed as a decision*).
 *
 * Empty for the three roles that never take a bill - the server sends them an empty card, the
 * same shape - so a screen that reads it needs no special case.
 */
export const CLASS_TERMS: Record<string, ClassTerms> = {};
export const PAYER_TERMS: Record<string, PayerTerms> = {};
export function hydrateTerms(t: Terms): void {
  replaceKeys(CLASS_TERMS, Object.fromEntries(t.classes.map((c) => [c.cls, c])));
  replaceKeys(PAYER_TERMS, Object.fromEntries(t.payers.map((p) => [`${p.kind}:${p.id}`, p])));
}

export type MasterData = {
  items: Record<string, Item>;
  locations: Record<string, Location>;
  prices: Record<string, Record<string, number>>;
  priceLists: PriceList[];
  menu: Record<string, string[]>;
  users: UserMin[];
};

const replaceKeys = <T extends object>(target: T, next: T) => {
  for (const k of Object.keys(target)) delete (target as Record<string, unknown>)[k];
  Object.assign(target, next);
};

/** Just the item master, for a write that added one (`POST /items` names "items"). The registry
 *  keeps its identity - screens hold a reference to it - so the contents are replaced in place,
 *  and `catalogVersion` in the store is what tells React the lists changed. */
export function hydrateItems(items: MasterData["items"]): void { replaceKeys(IT, items); }

/** Every price list's item->price map, for a write that moved one
 *  (`PUT /prices/:list/:it` names "prices"). Every list is replaced together because the server
 *  answers with all of them. */
export function hydratePrices(prices: MasterData["prices"]): void { replaceKeys(PL, prices); }

/** The price lists themselves, for a write that created, deleted or switched one
 *  (`changed: ["priceLists"]`). */
export function hydratePriceLists(priceLists: MasterData["priceLists"]): void {
  replaceKeys(PRICE_LISTS, Object.fromEntries(priceLists.map((pl) => [pl.id, pl])));
}

/** Just the menus, for a write that listed or delisted a product (`changed: ["menu"]`). */
export function hydrateMenus(menu: MasterData["menu"]): void { replaceKeys(MENU, menu); }

/** Just the location master, for a write that opened, edited, closed or reopened an outlet, or
 *  switched one onto another price list (`changed: ["locations"]`). Screens hold `LOC` by
 *  reference, so it is replaced in place. */
export function hydrateLocations(locations: MasterData["locations"]): void { replaceKeys(LOC, locations); }

/** Replace every registry's contents with the server's master data (`applySnapshot` calls this). */
export function hydrateMaster(m: MasterData): void {
  replaceKeys(IT, m.items);
  hydrateLocations(m.locations);
  hydratePrices(m.prices);
  hydratePriceLists(m.priceLists);
  hydrateMenus(m.menu);
  USERS.splice(0, USERS.length, ...m.users);
}

/**
 * What to show as a person's "base" next to their role. A counter operator,
 * store keeper or kitchen in-charge genuinely works out of one place, so their
 * location is the useful thing to show. An outlet manager oversees every shop
 * at once - as does a counter role given every outlet or a hospital-wide
 * feature - and a procurement officer is not tied to a single counter either.
 */
export function homeLabel(u: UserMin & { perms?: Permissions }): string | null {
  if (u.r === "buyer") return null;
  if (atOutlet(u.r) && readsHospitalWide(u.r, u.perms ?? DESK_DEFAULTS[u.r].perms)) return "All outlets";
  return LOC[u.loc].n;
}
