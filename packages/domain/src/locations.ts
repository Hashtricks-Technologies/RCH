import { KITCHEN, QUARANTINE, STORE, type Location, type Role } from "@rch/contract";

/** The master's location registry, keyed by location key - only the fields these rules read, so the
 *  admin page can pass its own list without inventing a par factor. */
type Locations = Record<string, Pick<Location, "n" | "type" | "active">>;

/** Absent reads as open, the way `Item.active` reads absent. */
const open = (l: Pick<Location, "active">): boolean => l.active !== false;

/**
 * The outlets, read from the master - never from a list compiled into either side. By printed name,
 * because that is the order a person scans a picker in, and by key after that so two outlets that
 * share a name still come out in one order everywhere. `open` leaves a closed outlet out: a picker
 * that *starts* something asks for the open ones, and a filter over what already happened asks for
 * all of them, since a closed outlet's bills are still bills.
 */
export function outletKeys(locations: Locations, opts: { open?: boolean } = {}): string[] {
  return Object.entries(locations)
    .filter(([, l]) => l.type === "Outlet" && (!opts.open || open(l)))
    .sort(([ka, a], [kb, b]) => a.n.localeCompare(b.n) || ka.localeCompare(kb))
    .map(([k]) => k);
}

/** Every place an operator works today: the central store, the central kitchen, then the open
 *  outlets. Quarantine is never here - stock is recorded there, and nobody acts there. A singleton
 *  the master has not sent yet is left out rather than named without a row behind it. */
export const operationalKeys = (locations: Locations): string[] =>
  [...[STORE, KITCHEN].filter((k) => locations[k]), ...outletKeys(locations, { open: true })];

/**
 * A role and a location are not independent. The kitchen in-charge works in the kitchen; the store
 * keeper and the buyer work at the central store; a counter operator and an outlet manager work at
 * an outlet that is still open. Nothing downstream checks the pairing - `requireLoc` only compares a
 * request against whatever the token says - so an account paired wrongly is refused nowhere else.
 */
export function worksAt(role: Role, key: string, location: Pick<Location, "type" | "active"> | undefined): boolean {
  if (!location) return false;
  if (role === "prod") return key === KITCHEN;
  if (role === "store" || role === "buyer") return key === STORE;
  return location.type === "Outlet" && open(location);
}

/** The same rule as a picker's list: every location `worksAt` would accept for this role. */
export const placesFor = (role: Role, locations: Locations): string[] =>
  role === "prod" ? [KITCHEN] : role === "store" || role === "buyer" ? [STORE] : outletKeys(locations, { open: true });

/** The keys the code itself names. An outlet called "Store" is fine; its key may not be `store`. */
const RESERVED: ReadonlySet<string> = new Set([STORE, KITCHEN, QUARANTINE]);
/** Twenty, so a `-NNN` suffix still fits inside the 24 characters `LocKeySchema` allows. */
const STEM = 20;

/**
 * The key a new outlet is given, from its name, once - it never changes afterwards, even when the
 * outlet is renamed, because every bill, move and ticket names it. Lower-case, runs of anything
 * outside a-z and 0-9 become one dash, a letter first (a name that starts with a digit, or has no
 * letters at all, is prefixed `outlet`), then `-2`, `-3`, … past a reserved key or one already taken.
 */
export function outletKeyFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const trim = (s: string) => s.slice(0, STEM).replace(/-+$/, "");
  const slug = trim(name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, ""));
  const stem = /^[a-z]/.test(slug) ? slug : trim(slug ? `outlet-${slug}` : "outlet");
  if (!RESERVED.has(stem) && !used.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const key = `${stem}-${n}`;
    if (!used.has(key)) return key;
  }
}
