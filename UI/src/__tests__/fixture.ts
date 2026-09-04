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
 * in a test file, where §5.1 says they belong.
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
 * The demo hospital, in the store. Master data goes through the same two hydrators the snapshot
 * uses, so a test sees exactly the registries a signed-in browser sees.
 *
 * It stays `setState` and deliberately does **not** go through `applySnapshot`. The fixtures'
 * times are already display strings (`"09:12"`, `"Yesterday"`, `"27-Aug"`) and `applySnapshot`
 * runs `fromWireTime` over everything it is handed; feeding it fixtures would turn every stamp
 * into garbage. Building the state directly is what `resetStore` has always done and it is still
 * right — what changed is only where the fixtures are imported from.
 */
export function resetStore() {
  hydrateMaster({ items: FX.IT, locations: FX.LOC, recipes: FX.RCP, prices: FX.PL, menu: FX.MENU, users: FX.USERS });
  hydrateRoster({ patients: FX.PATIENTS, staff: FX.STAFF, depts: FX.DEPTS });
  useApp.setState({
    user: null, auth: "signed-out",
    stock: clone(FX.seedStock), rsv: clone(FX.seedRsv()), ovr: {}, prices: basePrices(),
    menu: clone(FX.MENU), req: clone(FX.seedReq), tkt: clone(FX.seedTkt), prq: clone(FX.seedPrq),
    po: clone(FX.seedPo), pord: clone(FX.seedPord), batch: clone(FX.seedBatch), bills: clone(FX.seedBills),
    grn: clone(FX.seedGrn), vendors: clone(FX.seedVendors), sales: clone(FX.seedSales), dayLabels: FX.DAY_LABELS,
    contracts: FX.seedContracts(), productReqs: FX.seedProductRequests(), shopAsks: FX.seedShopAsks(),
    tickets: FX.seedTickets(),
    cart: {}, draft: [], prqDraft: [], drawer: null, toast: null, shopFilter: null,
  });
}
