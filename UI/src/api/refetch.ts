import { routes, type Changed } from "@rch/contract";
import { call } from "./client";
import {
  applyBatches, applyBills, applyContracts, applyGrns, applyItems, applyMenus, applyPayers,
  applyPos, applyPrices, applyProdOrders, applyProductRequests, applyRequests, applyRequisitions,
  applyRoster, applyShopAsks, applyStock, applySupportTickets, applyTickets, applyVendors,
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
  tickets: () => call(routes.tickets).then(applySupportTickets),
  prices: () => call(routes.prices).then(applyPrices),
  menu: () => call(routes.menus).then(applyMenus),
  // ---- payers ----
  roster: () => call(routes.roster).then(applyRoster),
  payers: () => call(routes.payers).then(applyPayers),
};

/**
 * Pull back exactly what a write said it changed.
 *
 * `stock`/`rsv`/`ovr` come from `GET /stock`, and every other collection the contract names
 * from its own GET — `bills`, `req`, `tkt`, `shopAsks`, `pord`, `batch`, `prq`, `po`, `grn`,
 * `vendors`, `contracts`, `productReqs`, `items`, `tickets` (the support desk,
 * `GET /support/tickets`), `prices` and `menu` (the manager's two), `roster` (the till's live
 * payer list, `GET /roster`) and `payers` (the manager's whole register, closed accounts
 * included, `GET /payers`) — each fetched at most once however many times the write named it,
 * which is what lets a payer write name both of its collections and still cost two reads.
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
      ? `${after} — the screen could not be refreshed; reload to see the latest.`
      : "Saved — but the screen could not be refreshed. Reload to see the latest.");
  }
}
