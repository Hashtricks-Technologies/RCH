import type { UserMin } from "../types";
import * as FX from "@rch/contract/fixtures";

// Registries. Mutable on purpose: the store can add a product, and hydrateMaster()
// replaces the contents with what the server returns. Screens import these directly,
// so they must keep their identity — assign into them, never reassign them.
export const LOC = { ...FX.LOC };
export const IT: Record<string, import("../types").Item> = { ...FX.IT };
export const RCP = { ...FX.RCP };
export const PL = { A: { ...FX.PL.A }, B: { ...FX.PL.B } };
export const MENU: Record<string, string[]> = Object.fromEntries(Object.entries(FX.MENU).map(([k, v]) => [k, [...v]]));
/** The directory the server sends: a name badge each. Nobody's contact details but your own
 *  travel over the wire, so this is `UserMin`, not `User` — the signed-in person's own full
 *  record lives in the store's `user`. */
export const USERS: UserMin[] = [...FX.USERS];
export const OUTLETS = [...FX.OUTLETS];
export const ALL_LOCS = [...FX.ALL_LOCS];
export const { PAR_FACTOR, PATIENTS, STAFF, DEPTS, STAFF_CREDIT_LIMIT, PO_APPROVAL_LIMIT } = FX;

export type MasterData = {
  items: Record<string, import("../types").Item>;
  locations: typeof FX.LOC;
  recipes: typeof FX.RCP;
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

/** Replace every registry's contents with the server's master data (Task 16 calls this). */
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
