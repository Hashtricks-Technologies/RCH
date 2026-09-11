import type { z } from "zod";
import { StockLocSchema } from "@rch/contract";
import type { SnapshotSchema, StockResponseSchema } from "@rch/contract";
import { hydrateItems, hydrateMaster, hydrateMenus, hydratePrices, hydrateRoster } from "../data/master";
import { fromWireBestBefore, fromWireDate, fromWireTime } from "../lib/fmt";
import { useApp } from "../store";
import { basePrices } from "../lib/selectors";
import type { Bill, Dated, HistEntry, StockLoc } from "../types";

export type Snapshot = z.infer<typeof SnapshotSchema>;
export type StockResponse = z.infer<typeof StockResponseSchema>;
const t = fromWireTime;
/**
 * The two things a document carries out of here: the `"HH:MM"` every table prints, and the
 * instant it was made from. Collapsing the instant on the way in was the whole of A1 — with
 * only `"HH:MM"` left, "today" could not be told from "this week", and `"22:00"` sorted above
 * `"09:00"` whichever day each belonged to. `at`/`t` still read the way they always did;
 * `iso` is the raw stamp beside them, for `isToday` and for every sort.
 */
/**
 * The instant to keep, given the value on the way in and whatever instant is already there.
 *
 * `fromWireTime` passes an `"HH:MM"` through unchanged, so it is safe to run twice; this has to
 * be too. A document that has already been through here carries a clock face where the wire
 * carried an instant, and stamping *that* as `iso` would replace a real instant with a string
 * no filter or sort can read. So when the value is already a display time, the instant it came
 * with stands.
 */
const SHOWN = /^\d{2}:\d{2}$/;
const instant = (raw: string, had: string | undefined) => (SHOWN.test(raw) ? had ?? "" : raw);
const stamped = <T extends { at: string; iso?: string }>(x: T) => ({ ...x, at: t(x.at), iso: instant(x.at, x.iso) });
const hist = (h: HistEntry[]): Dated<HistEntry>[] =>
  h.map((x) => ({ ...x, t: t(x.t), iso: instant(x.t, (x as Partial<Dated<HistEntry>>).iso) }));
const billed = (b: Bill[]): Dated<Bill>[] =>
  b.map((x) => ({ ...x, t: t(x.t), iso: instant(x.t, (x as Partial<Dated<Bill>>).iso) }));

/** Quarantine is here and nowhere else that an operator acts: stock is *reported* for the
 *  rejected-goods shelf, so the store keeper can see what was turned away at a goods receipt.
 *  Read off the schema rather than hand-listed, so a sixth reported location cannot be added to
 *  the contract and quietly missed here — `store/index.ts`'s `EMPTY_STOCK` reads the same list. */
const ALL_LOC: StockLoc[] = [...StockLocSchema.options];
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
    req: s.req.map((r) => ({ ...stamped(r), hist: hist(r.hist) })),
    tkt: s.tkt.map((x) => ({ ...x, hist: hist(x.hist) })),
    prq: s.prq.map((p) => ({ ...stamped(p), hist: hist(p.hist) })),
    po: s.po.map((o) => ({ ...stamped(o), eta: fromWireDate(o.eta), recv: o.recv ? t(o.recv) : undefined, hist: hist(o.hist) })),
    pord: s.pord.map((o) => ({ ...stamped(o), hist: hist(o.hist) })),
    batch: s.batch.map((b) => ({ ...b, at: t(b.at), bb: fromWireBestBefore(b.bb) })),
    bills: billed(s.bills),
    // `mfg`, `exp` and `invDate` are the vendor's printed dates and are shown raw.
    grn: s.grn.map(stamped),
    vendors: s.vendors,
    contracts: s.contracts.map((c) => ({ ...c, from: fromWireDate(c.from), to: fromWireDate(c.to) })),
    tickets: s.tickets.map((x) => ({ ...stamped(x), messages: x.messages.map((m) => ({ ...m, at: t(m.at) })) })),
    productReqs: s.productReqs.map(stamped),
    shopAsks: s.shopAsks.map(stamped),
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
  useApp.setState({ req: req.map((r) => ({ ...stamped(r), hist: hist(r.hist) })) });
}

/** GET /tickets -> the tickets. The lines and the OTP pass through; the history does not.
 *  This is what every handover, receipt and cancellation refetches through, so leaving it a
 *  pass-through would put raw ISO stamps into the drawer's trail the moment anything moved. */
export function applyTickets(tkt: Snapshot["tkt"]): void {
  useApp.setState({ tkt: tkt.map((x) => ({ ...x, hist: hist(x.hist) })) });
}

/** GET /support/tickets -> the desk. Times as "HH:MM", on the ticket and on every message. */
export function applySupportTickets(rows: Snapshot["tickets"]): void {
  useApp.setState({ tickets: rows.map((x) => ({ ...stamped(x), messages: x.messages.map((m) => ({ ...m, at: t(m.at) })) })) });
}

/** GET /shop-asks -> the shop-to-shop asks, times as "HH:MM". */
export function applyShopAsks(asks: Snapshot["shopAsks"]): void {
  useApp.setState({ shopAsks: asks.map(stamped) });
}

/** GET /prod-orders -> the kitchen's board, times as "HH:MM" and history stamps with them. */
export function applyProdOrders(pord: Snapshot["pord"]): void {
  useApp.setState({ pord: pord.map((o) => ({ ...stamped(o), hist: hist(o.hist) })) });
}

/** GET /batches -> the batch log. `bb` is an instant on the wire and a best-before on screen. */
export function applyBatches(batch: Snapshot["batch"]): void {
  useApp.setState({ batch: batch.map((b) => ({ ...b, at: t(b.at), bb: fromWireBestBefore(b.bb) })) });
}

/** GET /requisitions -> the buyer's desk, times as "HH:MM" and history stamps with them. */
export function applyRequisitions(prq: Snapshot["prq"]): void {
  useApp.setState({ prq: prq.map((p) => ({ ...stamped(p), hist: hist(p.hist) })) });
}

/** GET /purchase-orders -> the orders. `eta` is a wire date and is shown as DD-MMM-YYYY. */
export function applyPos(po: Snapshot["po"]): void {
  useApp.setState({ po: po.map((o) => ({ ...stamped(o), eta: fromWireDate(o.eta), recv: o.recv ? t(o.recv) : undefined, hist: hist(o.hist) })) });
}

/** GET /grns -> the receipts. `mfg`, `exp` and `invDate` are the vendor's printed dates, raw. */
export function applyGrns(grn: Snapshot["grn"]): void {
  useApp.setState({ grn: grn.map(stamped) });
}

/** GET /vendors -> the vendor master. Nothing on a vendor is a time or a date. */
export function applyVendors(vendors: Snapshot["vendors"]): void { useApp.setState({ vendors }); }

/** GET /contracts -> the rate contracts, their two validity dates as DD-MMM-YYYY. */
export function applyContracts(contracts: Snapshot["contracts"]): void {
  useApp.setState({ contracts: contracts.map((c) => ({ ...c, from: fromWireDate(c.from), to: fromWireDate(c.to) })) });
}

/** GET /product-requests -> the shops' asks for something not on the master yet. */
export function applyProductRequests(rows: Snapshot["productReqs"]): void {
  useApp.setState({ productReqs: rows.map(stamped) });
}

/** GET /items -> the catalogue every screen reads directly. `catalogVersion` is the signal. */
export function applyItems(items: Snapshot["items"]): void {
  hydrateItems(items);
  useApp.setState((s) => ({ catalogVersion: s.catalogVersion + 1 }));
}

/** GET /prices -> both shelf lists. The registry and the store's copy are the same two lists —
 *  `basePrices()` is what every screen reads — so the registry is filled first and copied out. */
export function applyPrices(prices: Snapshot["prices"]): void {
  hydratePrices(prices);
  useApp.setState((s) => ({ prices: basePrices(), catalogVersion: s.catalogVersion + 1 }));
}

/** GET /menus -> what each outlet lists. Like the catalogue, the registry is a module-level one
 *  (`MENU`), so `catalogVersion` is what tells a screen reading it directly that it moved. */
export function applyMenus(menu: Snapshot["menu"]): void {
  hydrateMenus(menu);
  useApp.setState((s) => ({ menu, catalogVersion: s.catalogVersion + 1 }));
}
