import { KITCHEN, QUARANTINE, STORE, type Location, type ProductReqStatus, type PordStatus, type ReqStatus, type Role, type ShopAskStatus, type TktStatus } from "@rch/contract";

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
  if (atOutlet(role)) return location.type === "Outlet" && open(location);
  return key === (role === "prod" ? KITCHEN : STORE);
}

/** The desks whose place is an outlet - the counter operator's and the outlet manager's - rather
 *  than the kitchen or the central store. A question about where a desk sits, never about what a
 *  role may do: that is a permission (`can`, `holds`). */
export const atOutlet = (role: Role): boolean => role !== "prod" && role !== "store" && role !== "buyer";

/** The same rule as a picker's list: every location `worksAt` would accept for this role. */
export const placesFor = (role: Role, locations: Locations): string[] =>
  atOutlet(role) ? outletKeys(locations, { open: true }) : [role === "prod" ? KITCHEN : STORE];

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

/**
 * Which statuses still commit an outlet to something - the documents a close has to wait for.
 *
 * Not read off the transition tables: a dispatched kitchen order and a sent shop ask each keep an
 * undo edge there, yet the ticket each one raised is what holds the outlet from then on. Each record
 * is exhaustive over its closed union, so a status added later fails typecheck here until somebody
 * decides whether it holds an outlet open.
 */
export const HOLDS_OUTLET = {
  request: {
    Draft: true, "Request sent": true, "Manager approved": true, "Partially approved": true, "Ticket issued": true,
    Collected: true, Received: true, Closed: false, Rejected: false, Cancelled: false,
  } satisfies Record<ReqStatus, boolean>,
  ticket: { Issued: true, Collected: true, Received: false, Cancelled: false } satisfies Record<TktStatus, boolean>,
  prodOrder: { New: true, Accepted: true, "In kitchen": true, Ready: true, Dispatched: false, Declined: false } satisfies Record<PordStatus, boolean>,
  shopAsk: { Asked: true, Sent: false, Declined: false } satisfies Record<ShopAskStatus, boolean>,
  productReq: { Requested: true, Created: false, Declined: false } satisfies Record<ProductReqStatus, boolean>,
};

/** The statuses a `HOLDS_OUTLET` record marks as holding, in the record's own order. */
export const holding = <S extends string>(t: Record<S, boolean>): S[] => (Object.keys(t) as S[]).filter((s) => t[s]);

/** What still depends on an outlet, counted by the server under the close's own row lock. */
export type OutletBlockers = {
  stock: number; tickets: number; requests: number; kitchenOrders: number; shopAsks: number; productRequests: number;
  /** Employee numbers of the active accounts based there. */
  staff: string[];
  /** Whether the outlet's register is still open - a business day nobody has taken a Z for. A
   *  close is allowed to go through with one open only if the money has been accounted for, and
   *  it has not: `closeRegister` deliberately still works at a closed outlet rather than stranding
   *  the takings, but the honest order is to Z first and close after. */
  openRegister: boolean;
};

/**
 * The close's refusal - every blocker in one sentence, the shape the dispatch rule refuses in, so the
 * admin clears the list once rather than learning it one refusal at a time. `null` when nothing is
 * left and the outlet may close.
 */
export function closeRefusal(name: string, b: OutletBlockers): string | null {
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const parts = [
    b.stock > 0 && `stock on hand (${count(b.stock, "item")})`,
    b.tickets > 0 && count(b.tickets, "open ticket"),
    b.requests > 0 && count(b.requests, "open stock request"),
    b.kitchenOrders > 0 && count(b.kitchenOrders, "open kitchen order"),
    b.shopAsks > 0 && count(b.shopAsks, "open shop ask"),
    b.productRequests > 0 && count(b.productRequests, "open product request"),
    b.staff.length > 0 && `${b.staff.length} active staff (${b.staff.join(", ")})`,
    b.openRegister && "an open register (take its Z-report first)",
  ].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Refused - ${name} still has ${list}`;
}
