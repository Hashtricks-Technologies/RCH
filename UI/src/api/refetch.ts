import { routes, type Changed } from "@rch/contract";
import { call } from "./client";
import {
  applyBatches, applyBills, applyContracts, applyGrns, applyItems, applyPos, applyProdOrders,
  applyProductRequests, applyRequests, applyRequisitions, applyShopAsks, applyStock, applyTickets,
  applyVendors,
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
};

/**
 * Pull back exactly what a write said it changed.
 *
 * `stock`/`rsv`/`ovr` come from `GET /stock`, and `bills`, `req`, `tkt`, `shopAsks`, `pord`,
 * `batch`, `prq`, `po`, `grn`, `vendors`, `contracts`, `productReqs` and `items` each from their
 * own GET, every one of them fetched at most once however many times the write named it. Only
 * `prices`, `menu` and `tickets` have no narrow reader now — the manager's price and menu writes
 * and Phase 6's support desk — so those cost one snapshot, and a mixed set takes that alone.
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
