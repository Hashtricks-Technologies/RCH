import { routes, type Changed } from "@rch/contract";
import { call } from "./client";
import {
  applyAccounts, applyAdjustmentRequests, applyAdjustments, applyAdminLocations, applyAdminPayers, applyBatches, applyBills, applyContracts, applyDeskTickets, applyGrns, applyItems, applyLocations, applyMenus,
  applyPos, applyPriceLists, applyPrices, applyProdOrders, applyProductRequests, applyRequests,
  applyRequisitions, applyRoster, applyShopAsks, applyStock, applySupportTickets, applyTickets,
  applyTerms, applyVendors,
} from "./wire";
import { useApp } from "../store";

/** The slices `GET /stock` answers for, in one call. */
const STOCK: readonly Changed[] = ["stock", "rsv", "ovr"];

/** One reader per slice that has one; everything else falls through to the snapshot. */
const NARROW: Partial<Record<Changed, () => Promise<void>>> = {
  bills: () => call(routes.bills).then(applyBills),
  req: () => call(routes.requests).then(applyRequests),
  tkt: () => call(routes.ticketsList).then(applyTickets),
  shopAsks: () => call(routes.shopAsks).then(applyShopAsks),
  pord: () => call(routes.prodOrders).then(applyProdOrders),
  batch: () => call(routes.batches).then(applyBatches),
  prq: () => call(routes.requisitions).then(applyRequisitions),
  po: () => call(routes.purchaseOrders).then(applyPos),
  grn: () => call(routes.grns).then(applyGrns),
  vendors: () => call(routes.vendors).then(applyVendors),
  contracts: () => call(routes.contracts).then(applyContracts),
  productReqs: () => call(routes.productRequests).then(applyProductRequests),
  items: () => call(routes.items).then(applyItems),
  // The admin answers every ticket from the desk, and has no list of its own to read: the same
  // `tickets` a reporter's write names is what puts a new ticket or a reply on the desk live.
  tickets: () => useApp.getState().user?.admin
    ? call(routes.deskTickets).then(applyDeskTickets)
    : call(routes.tickets).then(applySupportTickets),
  prices: () => call(routes.prices).then(applyPrices),
  priceLists: () => call(routes.priceLists).then(applyPriceLists),
  menu: () => call(routes.menus).then(applyMenus),
  // ---- payers ----
  // Both are `access: "any"` and answer an empty body to a caller who never takes a bill, so
  // every *operational* session may read them. The super admin is the exception and has to be
  // guarded here: `rbac.ts` answers an admin token 404 on every route that is not
  // `access: "admin"`, and an admin's `/admin` tab is on the change stream like everyone else -
  // so without this a manager saving a rate, or the admin's own payer write naming `roster`,
  // would fail that tab's whole `Promise.all` and toast "the screen could not be refreshed"
  // over a page of theirs that never changed. Same shape as `locations` below.
  roster: () => useApp.getState().user?.admin ? Promise.resolve() : call(routes.roster).then(applyRoster),
  terms: () => useApp.getState().user?.admin ? Promise.resolve() : call(routes.payerTerms).then(applyTerms),
  // Who owes what, and every recent payment: two reads behind one collection, because they are
  // two halves of one screen and a settlement moves both. The action answers `false` on a
  // failure rather than throwing, so a manager's tab shows its own outage line and a tab with
  // no Credit screen open is not told anything went wrong.
  receivables: () => useApp.getState().user?.r === "manager"
    ? useApp.getState().loadReceivables().then(() => undefined)
    : Promise.resolve(),
  // ---- admin: the payer register. Read two ways, like `locations`/`outlets`: the super admin
  // pulls back its own whole list, and an operational session's copy comes back through
  // `roster`, which every payer write names alongside this one.
  payers: () => useApp.getState().user?.admin ? call(routes.adminPayers).then(applyAdminPayers) : Promise.resolve(),
  // ---- adjustments
  adjustments: () => call(routes.adjustments).then(applyAdjustments),
  // ---- adjustment requests
  adjReq: () => call(routes.adjustmentRequests).then(applyAdjustmentRequests),
  // ---- admin: account management
  accounts: () => call(routes.adminUsers).then(applyAccounts),
  // ---- outlets. One change, read two ways: an operational session pulls back the location master
  // every screen lists outlets from; the super admin, whose token reaches no location read but its
  // own, pulls back the admin list. Each reader does nothing for the other session.
  locations: () => useApp.getState().user?.admin ? Promise.resolve() : call(routes.locations).then(applyLocations),
  outlets: () => useApp.getState().user?.admin ? call(routes.adminLocations).then(applyAdminLocations) : Promise.resolve(),
  // ---- audit log: nothing is read here. The Audit log tab's list never moves by itself (spec
  // 5.2), so a notice only adds to the count behind the tab's "New events - show" pill.
  // The server sends `audit` to admin streams alone; the guard keeps any other session from counting one.
  audit: () => {
    if (useApp.getState().user?.admin) useApp.getState().bumpAuditFresh();
    return Promise.resolve();
  },
};

/**
 * Pull back exactly what a write said it changed.
 *
 * `stock`/`rsv`/`ovr` come from `GET /stock`, and every other collection the contract names
 * from its own GET - `bills`, `req`, `tkt`, `shopAsks`, `pord`, `batch`, `prq`, `po`, `grn`,
 * `vendors`, `contracts`, `productReqs`, `items`, `tickets` (the support desk,
 * `GET /support/tickets`), `prices`, `priceLists` and `menu` (the manager's three), `roster` (the
 * till's live payer list, `GET /roster`), `adjustments` (the write-off register, `GET
 * /adjustments`), `locations` (the location master, `GET /locations`) and `outlets` (the admin
 * page's own list, `GET /admin/locations`) - each fetched at most once however many times the
 * write named it, which is what lets an outlet write name both of its collections and still cost
 * one read.
 * Nothing costs a snapshot any more: taking one pulled the whole hospital back down and, until
 * this wave, put every screen behind the loading splash to do it. The fallback below stays for
 * the next collection added to the enum and not to `NARROW`; a mixed set takes the snapshot
 * alone, as it always did.
 *
 * `after` is the sentence the write already succeeded with. When the read-back fails it is
 * kept and qualified rather than replaced, so the operator still learns their bill was taken.
 */
export async function refetch(changed: readonly Changed[], after?: string): Promise<void> {
  const want = new Set<Changed>(changed);
  try {
    if ([...want].some((c) => !NARROW[c] && !STOCK.includes(c))) {
      await useApp.getState().loadSnapshot();
      return;
    }
    await Promise.all([
      ...(STOCK.some((c) => want.has(c)) ? [call(routes.stock).then(applyStock)] : []),
      ...[...want].filter((c) => NARROW[c]).map((c) => NARROW[c]!()),
    ]);
  } catch {
    // The write itself landed; only the read-back did not. Saying "could not take the bill"
    // here would send the operator round to do it a second time, so this keeps what did
    // happen in front of them. (`loadSnapshot` reports its own failures and never throws.)
    useApp.getState().notify(after
      ? `${after} - the screen could not be refreshed; reload to see the latest.`
      : "Saved - but the screen could not be refreshed. Reload to see the latest.");
  }
}
