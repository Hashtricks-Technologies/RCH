import type { Item, Location, Payer, PayerRoster, Recipe, UserMin } from "../types";

// `STAFF_CREDIT_LIMIT` is deliberately not among these any more: the till reads the ceiling off
// `GET /reports/credit/:kind/:id` (`credit.limit`), because the number that matters is the one
// the server will refuse on, not a constant compiled into the bundle.
export { ALL_LOCS, OUTLETS, PO_APPROVAL_LIMIT } from "@rch/contract";

// Registries. Mutable on purpose: the store can add a product, and hydrateMaster()
// replaces the contents with what the server returns. Screens import these directly,
// so they must keep their identity — assign into them, never reassign them.
//
// They start **empty**. Nothing here is data: the app renders no screen until `auth` reaches
// "ready", which only a snapshot can do, and the snapshot is what fills every one of them.
// The demo hospital lives in `@rch/contract/fixtures` and is imported by tests alone (§5.1).
export const LOC: Record<string, Location> = {};
export const IT: Record<string, Item> = {};
export const RCP: Record<string, Recipe> = {};
export const PL: { A: Record<string, number>; B: Record<string, number> } = { A: {}, B: {} };
export const MENU: Record<string, string[]> = {};
/** The directory the server sends: a name badge each. Nobody's contact details but your own
 *  travel over the wire, so this is `UserMin`, not `User` — the signed-in person's own full
 *  record lives in the store's `user`. */
export const USERS: UserMin[] = [];

/** Who a bill may be charged to. Mutable registries like IT and LOC, for the same reason: the
 *  counter's screen imports them directly, so they must keep their identity — assign into them,
 *  never reassign them. Filled by `hydrateRoster` from the snapshot's `roster`, which the server
 *  reads out of the `payers` table it has been validating the till against since Phase 3. */
export const PATIENTS: Payer[] = [];
export const STAFF: Payer[] = [];
export const DEPTS: Payer[] = [];
export function hydrateRoster(r: PayerRoster): void {
  PATIENTS.splice(0, PATIENTS.length, ...r.patients);
  STAFF.splice(0, STAFF.length, ...r.staff);
  DEPTS.splice(0, DEPTS.length, ...r.depts);
}

export type MasterData = {
  items: Record<string, Item>;
  locations: Record<string, Location>;
  recipes: Record<string, Recipe>;
  prices: { A: Record<string, number>; B: Record<string, number> };
  menu: Record<string, string[]>;
  users: UserMin[];
};

const replaceKeys = <T extends object>(target: T, next: T) => {
  for (const k of Object.keys(target)) delete (target as Record<string, unknown>)[k];
  Object.assign(target, next);
};

/** Just the item master, for a write that added one (`POST /items` names "items"). The registry
 *  keeps its identity — screens hold a reference to it — so the contents are replaced in place,
 *  and `catalogVersion` in the store is what tells React the lists changed. */
export function hydrateItems(items: MasterData["items"]): void { replaceKeys(IT, items); }

/** Replace every registry's contents with the server's master data (`applySnapshot` calls this). */
export function hydrateMaster(m: MasterData): void {
  replaceKeys(IT, m.items);
  replaceKeys(LOC, m.locations);
  replaceKeys(RCP, m.recipes);
  replaceKeys(PL.A, m.prices.A);
  replaceKeys(PL.B, m.prices.B);
  replaceKeys(MENU, m.menu);
  USERS.splice(0, USERS.length, ...m.users);
}

/**
 * What to show as a person's "base" next to their role. A counter operator,
 * store keeper or kitchen in-charge genuinely works out of one place, so their
 * location is the useful thing to show. An outlet manager oversees every shop
 * at once and a procurement officer is not tied to a single counter either.
 */
export function homeLabel(u: UserMin): string | null {
  if (u.r === "manager") return "All outlets";
  if (u.r === "buyer") return null;
  return LOC[u.loc].n;
}
