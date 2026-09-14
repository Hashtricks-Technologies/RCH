import * as FX from "@rch/contract/fixtures";
import { useApp } from "../store";
import { setAccessToken } from "../api/session";
import { hydrateMaster, hydrateRoster } from "../data/master";
import { basePrices } from "../lib/selectors";
import type { Role } from "../types";

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
export const S = () => useApp.getState();

/**
 * Sign in, the way `login()` leaves the store: a token in memory, the caller's own whole record,
 * and `auth: "ready"`. The store's own `signIn` hook is gone — it read the fixtures from inside
 * production code, which is exactly what this phase deleted — so the fixtures are imported here,
 * in a test file, which is where they belong.
 */
export const as = (role: Role) => {
  setAccessToken("test-token");
  useApp.setState({ user: FX.USERS.find((u) => u.r === role)!, auth: "ready", mustChangePassword: false, drawer: null });
};

/** What `logout()` leaves behind. */
export const signedOut = () => {
  setAccessToken(null);
  useApp.setState({ user: null, auth: "signed-out", drawer: null, mustChangePassword: false });
};

/**
 * The store keeps the instant beside the printed time now (`Dated` in `types.ts`), and the
 * fixtures only ever carried the printed one — they were written for screens, not for a wire.
 * So the reset stamps one: **today, moments ago**, offset by a millisecond per minute of the
 * clock face the fixture shows.
 *
 * Today is the point. Every "today" figure at a counter filters on `iso`, and a seed dated any
 * other day would empty every dashboard in this suite. The offsets are milliseconds rather than
 * minutes so that no seed can fall on the far side of an IST midnight from "now" while still
 * ordering among themselves the way their own printed times read.
 */
const isoOf = (now: number, display: unknown): string => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(display ?? ""));
  const minuteOfDay = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  return new Date(now - (1439 - minuteOfDay)).toISOString();
};
type Trail = { hist: { s: string; who: string; t: string }[] };

/**
 * The demo hospital, in the store. Master data goes through the same two hydrators the snapshot
 * uses, so a test sees exactly the registries a signed-in browser sees.
 *
 * It stays `setState` and deliberately does **not** go through `applySnapshot`. The fixtures'
 * times are already display strings (`"09:12"`, `"Yesterday"`, `"27-Aug"`) and `applySnapshot`
 * runs `fromWireTime` over everything it is handed; feeding it fixtures would turn every stamp
 * into garbage. Building the state directly is what `resetStore` has always done and it is still
 * right — what changed is only where the fixtures are imported from, and that each seed now
 * carries the instant the store expects beside the time it prints.
 */
export function resetStore() {
  hydrateMaster({ items: FX.IT, locations: FX.LOC, recipes: FX.RCP, prices: FX.PL, menu: FX.MENU, users: FX.USERS });
  hydrateRoster({ patients: FX.PATIENTS, staff: FX.STAFF, depts: FX.DEPTS });
  const now = Date.now();
  const dated = <T extends { at: string }>(r: T) => ({ ...r, iso: isoOf(now, r.at) });
  const trailed = <T extends Trail>(r: T) => ({ ...r, hist: r.hist.map((h) => ({ ...h, iso: isoOf(now, h.t) })) });
  const doc = <T extends Trail & { at: string }>(r: T) => dated(trailed(r));
  useApp.setState({
    user: null, auth: "signed-out",
    stock: clone(FX.seedStock), rsv: clone(FX.seedRsv()), ovr: {}, prices: basePrices(),
    menu: clone(FX.MENU),
    req: clone(FX.seedReq).map(doc), tkt: clone(FX.seedTkt).map(trailed), prq: clone(FX.seedPrq).map(doc),
    po: clone(FX.seedPo).map(doc), pord: clone(FX.seedPord).map(doc), batch: clone(FX.seedBatch).map(dated),
    bills: clone(FX.seedBills).map((b) => ({ ...b, iso: isoOf(now, b.t) })),
    grn: clone(FX.seedGrn).map(dated), vendors: clone(FX.seedVendors), sales: clone(FX.seedSales), dayLabels: FX.DAY_LABELS,
    contracts: FX.seedContracts(), productReqs: FX.seedProductRequests().map(dated), shopAsks: FX.seedShopAsks().map(dated),
    tickets: FX.seedTickets().map(dated),
    // ---- adjustments: nothing has ever been written off in the demo hospital, so the register
    // starts empty — the same shape the fixtures give quarantine's shelf.
    adjustments: [],
    cart: {}, draft: [], prqDraft: [], drawer: null, toast: null, shopFilter: null,
    // ---- payers ----
    // Empty, not seeded: the manager's register has no fixture, because nothing on the snapshot
    // carries it — the screen asks `GET /payers` for it on the way in.
    payers: [],
    // ---- admin: account management ----
    // Same reason as `payers` above: nothing on the snapshot carries the account list or its
    // action log, and leaving either out of this reset would let one test's rows leak into the
    // next one's (`setState` merges, it does not replace).
    accounts: [], adminActions: [],
  });
}
