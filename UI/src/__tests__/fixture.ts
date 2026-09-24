import * as FX from "@rch/contract/fixtures";
import { useApp } from "../store";
import { setAccessToken } from "../api/session";
import { hydrateMaster, hydrateRoster, hydrateTerms } from "../data/master";
import { basePrices } from "../lib/selectors";
import { DESK_DEFAULTS } from "@rch/domain";
import { initialAudit } from "../store/audit";
import type { AdjustmentRequest, Contract, Role, User } from "../types";
import type { ComponentType } from "react";
import { DESK_NAV, type ScreenKey } from "../screens";
import { screenFor } from "../registry";

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * Every action the store was built with, captured once before any test can overwrite one.
 *
 * A test that stubs an action does it with `setState`, and `setState` merges - so the stub
 * outlives the test and every later one in the file calls the mock instead of the real thing.
 * That is invisible until a *different* test happens to depend on the action that was stubbed,
 * which is how a `vi.fn()` for `openDrawer` in the price-list tests left the POS bill tests
 * asserting against a drawer that never opened, three hundred lines away and passing in
 * isolation. `resetStore` puts these back, so a stub lasts exactly one test.
 */
const ACTIONS = Object.fromEntries(
  Object.entries(useApp.getState()).filter(([, v]) => typeof v === "function"),
) as Partial<ReturnType<typeof useApp.getState>>;
export const S = () => useApp.getState();

/**
 * Sign in, the way `login()` leaves the store: a token in memory, the caller's own whole record,
 * and `auth: "ready"`. The store's own `signIn` hook is gone - it read the fixtures from inside
 * production code, which is exactly what this phase deleted - so the fixtures are imported here,
 * in a test file, which is where they belong.
 */
/** The first fixture account on a desk, holding what that desk's seeded role holds - as `/me`
 *  answers for an account on the seeded role. */
export const userOf = (role: Role): User =>
  ({ ...FX.USERS.find((u) => u.r === role && !u.admin)!, perms: DESK_DEFAULTS[role].perms });
export const as = (role: Role) => {
  setAccessToken("test-token");
  useApp.setState({ user: userOf(role), auth: "ready", mustChangePassword: false, drawer: null });
};

/**
 * The screens a desk's seeded role sees, keyed by screen key, as its own sidebar resolves them -
 * `bills` the manager's every-outlet view for a manager and the counter's own for a counter.
 * For a suite that mounts one screen straight off a desk rather than through the router.
 */
export const deskScreens = (role: Role): Record<ScreenKey, ComponentType> => Object.fromEntries(
  DESK_NAV[role].flatMap((g) => g.keys).map((k) => [k, screenFor({ r: role, wide: role !== "counter" }, k)]),
) as Record<ScreenKey, ComponentType>;

/** What `logout()` leaves behind. */
export const signedOut = () => {
  setAccessToken(null);
  useApp.setState({ user: null, auth: "signed-out", drawer: null, mustChangePassword: false });
};

/**
 * The store keeps the instant beside the printed time now (`Dated` in `types.ts`), and the
 * fixtures only ever carried the printed one - they were written for screens, not for a wire.
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

/** The one seed row for a feature the demo fixtures never carried: a counter's ask to correct
 *  its own shelf, undecided. Not in `@rch/contract/fixtures` because nothing outside the UI's
 *  own screen tests needs it yet - the API's own tests build one with `given.adjustmentRequest`. */
const ADJREQ: AdjustmentRequest = {
  id: "ADJREQ-2026-01", loc: "coffee", reason: "wastage", note: "Fridge failed overnight",
  by: "Kavitha Raman", at: "09:10", lines: [{ it: "cup", qty: -20 }],
  st: "Request sent", hist: [{ s: "Request sent", who: "Kavitha Raman", t: "09:10" }],
};

/**
 * The demo hospital, in the store. Master data goes through the same two hydrators the snapshot
 * uses, so a test sees exactly the registries a signed-in browser sees.
 *
 * It stays `setState` and deliberately does **not** go through `applySnapshot`. The fixtures'
 * times are already display strings (`"09:12"`, `"Yesterday"`, `"27-Aug"`) and `applySnapshot`
 * runs `fromWireTime` over everything it is handed; feeding it fixtures would turn every stamp
 * into garbage. Building the state directly is what `resetStore` has always done and it is still
 * right - what changed is only where the fixtures are imported from, and that each seed now
 * carries the instant the store expects beside the time it prints.
 */
export function resetStore() {
  hydrateMaster({ items: FX.IT, locations: FX.LOC, prices: FX.PL, priceLists: FX.PRICE_LISTS, menu: FX.MENU, users: FX.USERS });
  hydrateRoster({ staff: FX.STAFF, depts: FX.DEPTS, doctors: FX.DOCTORS });
  // The rate card the demo hospital opens on, so a preview in the browser is the rate the
  // server would price against. The exceptions carry the payer's own name, exactly as
  // `GET /payer-terms` sends them.
  hydrateTerms({
    classes: FX.CLASS_TERMS,
    payers: FX.PAYER_TERMS.map((t) => ({
      ...t, name: [...FX.STAFF, ...FX.DEPTS, ...FX.DOCTORS].find((p) => p.kind === t.kind && p.id === t.id)?.name ?? t.id,
    })),
  });
  useApp.setState(ACTIONS);
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
    // No seeded contract has moved its rate, so none carries a `changes` trail to stamp.
    contracts: FX.seedContracts() as Contract[], productReqs: FX.seedProductRequests().map(dated), shopAsks: FX.seedShopAsks().map(dated),
    tickets: FX.seedTickets().map(dated),
    // ---- adjustments: nothing has ever been written off in the demo hospital, so the register
    // starts empty - the same shape the fixtures give quarantine's shelf.
    adjustments: [],
    // ---- adjustment requests: one open ask, undecided, so a screen or a drawer test has a
    // real document to open rather than an empty state.
    adjReq: [ADJREQ].map(doc),
    tills: {}, draft: [], prqDraft: [], poolVendor: {}, drawer: null, toast: null, shopFilter: null,
    // ---- admin: account management ----
    // Empty, not seeded: nothing on the snapshot carries the account list or its
    // action log, and leaving either out of this reset would let one test's rows leak into the
    // next one's (`setState` merges, it does not replace).
    accounts: [], adminActions: [], deskTickets: [],
    // ---- audit log: the tab's list, filter and pill count, back to a first visit's.
    audit: initialAudit(),
  });
}
