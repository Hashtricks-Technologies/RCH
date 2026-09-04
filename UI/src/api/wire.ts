import type { z } from "zod";
import type { SnapshotSchema, StockResponseSchema } from "@rch/contract";
import { hydrateItems, hydrateMaster, hydrateRoster } from "../data/master";
import { fromWireBestBefore, fromWireDate, fromWireTime } from "../lib/fmt";
import { useApp } from "../store";
import { basePrices } from "../lib/selectors";
import type { Bill, StockLoc } from "../types";

export type Snapshot = z.infer<typeof SnapshotSchema>;
export type StockResponse = z.infer<typeof StockResponseSchema>;
const t = fromWireTime;
const hist = (h: { s: string; who: string; t: string }[]) => h.map((x) => ({ ...x, t: t(x.t) }));
const billed = (b: Bill[]) => b.map((x) => ({ ...x, t: t(x.t) }));

/** Quarantine is here and nowhere else that an operator acts: stock is *reported* for the
 *  rejected-goods shelf, so the store keeper can see what was turned away at a goods receipt. */
const ALL_LOC: StockLoc[] = ["store", "kitchen", "rest", "coffee", "kiosk", "quarantine"];
/**
 * A counter operator's snapshot is scoped to its own location, so the server
 * omits the rest. The store's map is exhaustive — an absent location is empty,
 * not missing, or every `stock[loc][it]` read would throw.
 */
const stockOf = (s: Snapshot["stock"]): Record<StockLoc, Record<string, number>> =>
  Object.fromEntries(ALL_LOC.map((l) => [l, s[l] ?? {}])) as Record<StockLoc, Record<string, number>>;

/** Server shape -> the store's shape. Times become "HH:MM", dates "DD-MMM-YYYY"; nothing else changes. */
export function applySnapshot(s: Snapshot): void {
  hydrateMaster({ items: s.items, locations: s.locations, recipes: s.recipes, prices: s.prices, menu: s.menu, users: s.users });
  // Who a bill may be charged to comes off the `payers` table the till has been checked
  // against since Phase 3, so a patient admitted this morning is billable without a release.
  hydrateRoster(s.roster);
  useApp.setState((prev) => ({
    user: s.user,
    // The catalogue is a module-level registry, not store state, so a snapshot that replaces
    // it changes nothing React can see. `applyItems` has always bumped this; a full snapshot —
    // an SSE `resync`, or the fallback refetch — brings new items the same way and must too.
    catalogVersion: prev.catalogVersion + 1,
    stock: stockOf(s.stock), rsv: s.rsv, ovr: s.ovr, prices: basePrices(), menu: s.menu,
    req: s.req.map((r) => ({ ...r, at: t(r.at), hist: hist(r.hist) })),
    tkt: s.tkt.map((x) => ({ ...x, hist: hist(x.hist) })),
    prq: s.prq.map((p) => ({ ...p, at: t(p.at), hist: hist(p.hist) })),
    po: s.po.map((o) => ({ ...o, at: t(o.at), eta: fromWireDate(o.eta), recv: o.recv ? t(o.recv) : undefined, hist: hist(o.hist) })),
    pord: s.pord.map((o) => ({ ...o, at: t(o.at), hist: hist(o.hist) })),
    batch: s.batch.map((b) => ({ ...b, at: t(b.at), bb: fromWireBestBefore(b.bb) })),
    bills: billed(s.bills),
    // `mfg`, `exp` and `invDate` are the vendor's printed dates and are shown raw.
    grn: s.grn.map((g) => ({ ...g, at: t(g.at) })),
    vendors: s.vendors,
    contracts: s.contracts.map((c) => ({ ...c, from: fromWireDate(c.from), to: fromWireDate(c.to) })),
    tickets: s.tickets.map((x) => ({ ...x, at: t(x.at), messages: x.messages.map((m) => ({ ...m, at: t(m.at) })) })),
    productReqs: s.productReqs.map((p) => ({ ...p, at: t(p.at) })),
    shopAsks: s.shopAsks.map((a) => ({ ...a, at: t(a.at) })),
    sales: s.sales, dayLabels: s.dayLabels,
  }));
}

/**
 * GET /stock -> the three balance maps, through the same location fill as the snapshot's.
 * A write that only moved stock refreshes with this instead of a whole snapshot.
 */
export function applyStock(s: StockResponse): void {
  useApp.setState({ stock: stockOf(s.stock), rsv: s.rsv, ovr: s.ovr });
}

/** GET /bills -> the bill list, times as "HH:MM". */
export function applyBills(bills: Bill[]): void {
  useApp.setState({ bills: billed(bills) });
}

/** GET /requests -> the request desk, times as "HH:MM" and history stamps with them. */
export function applyRequests(req: Snapshot["req"]): void {
  useApp.setState({ req: req.map((r) => ({ ...r, at: t(r.at), hist: hist(r.hist) })) });
}

/** GET /tickets -> the tickets. The lines and the OTP pass through; the history does not.
 *  This is what every handover, receipt and cancellation refetches through, so leaving it a
 *  pass-through would put raw ISO stamps into the drawer's trail the moment anything moved. */
export function applyTickets(tkt: Snapshot["tkt"]): void {
  useApp.setState({ tkt: tkt.map((x) => ({ ...x, hist: hist(x.hist) })) });
}

/** GET /support/tickets -> the desk. Times as "HH:MM", on the ticket and on every message. */
export function applySupportTickets(rows: Snapshot["tickets"]): void {
  useApp.setState({ tickets: rows.map((x) => ({ ...x, at: t(x.at), messages: x.messages.map((m) => ({ ...m, at: t(m.at) })) })) });
}

/** GET /shop-asks -> the shop-to-shop asks, times as "HH:MM". */
export function applyShopAsks(asks: Snapshot["shopAsks"]): void {
  useApp.setState({ shopAsks: asks.map((a) => ({ ...a, at: t(a.at) })) });
}

/** GET /prod-orders -> the kitchen's board, times as "HH:MM" and history stamps with them. */
export function applyProdOrders(pord: Snapshot["pord"]): void {
  useApp.setState({ pord: pord.map((o) => ({ ...o, at: t(o.at), hist: hist(o.hist) })) });
}

/** GET /batches -> the batch log. `bb` is an instant on the wire and a best-before on screen. */
export function applyBatches(batch: Snapshot["batch"]): void {
  useApp.setState({ batch: batch.map((b) => ({ ...b, at: t(b.at), bb: fromWireBestBefore(b.bb) })) });
}

/** GET /requisitions -> the buyer's desk, times as "HH:MM" and history stamps with them. */
export function applyRequisitions(prq: Snapshot["prq"]): void {
  useApp.setState({ prq: prq.map((p) => ({ ...p, at: t(p.at), hist: hist(p.hist) })) });
}

/** GET /purchase-orders -> the orders. `eta` is a wire date and is shown as DD-MMM-YYYY. */
export function applyPos(po: Snapshot["po"]): void {
  useApp.setState({ po: po.map((o) => ({ ...o, at: t(o.at), eta: fromWireDate(o.eta), recv: o.recv ? t(o.recv) : undefined, hist: hist(o.hist) })) });
}

/** GET /grns -> the receipts. `mfg`, `exp` and `invDate` are the vendor's printed dates, raw. */
export function applyGrns(grn: Snapshot["grn"]): void {
  useApp.setState({ grn: grn.map((g) => ({ ...g, at: t(g.at) })) });
}

/** GET /vendors -> the vendor master. Nothing on a vendor is a time or a date. */
export function applyVendors(vendors: Snapshot["vendors"]): void { useApp.setState({ vendors }); }

/** GET /contracts -> the rate contracts, their two validity dates as DD-MMM-YYYY. */
export function applyContracts(contracts: Snapshot["contracts"]): void {
  useApp.setState({ contracts: contracts.map((c) => ({ ...c, from: fromWireDate(c.from), to: fromWireDate(c.to) })) });
}

/** GET /product-requests -> the shops' asks for something not on the master yet. */
export function applyProductRequests(rows: Snapshot["productReqs"]): void {
  useApp.setState({ productReqs: rows.map((p) => ({ ...p, at: t(p.at) })) });
}

/** GET /items -> the catalogue every screen reads directly. `catalogVersion` is the signal. */
export function applyItems(items: Snapshot["items"]): void {
  hydrateItems(items);
  useApp.setState((s) => ({ catalogVersion: s.catalogVersion + 1 }));
}
