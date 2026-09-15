import type { z } from "zod";
import type { SnapshotSchema, StockResponseSchema } from "@rch/contract";
import { hydrateItems, hydrateLocations, hydrateMaster, hydrateMenus, hydratePriceLists, hydratePrices, hydrateRoster, LOC } from "../data/master";
import { fromWireBestBefore, fromWireDate, fromWireTime } from "../lib/fmt";
import { useApp } from "../store";
import { basePrices } from "../lib/selectors";
import type { AdminAction, AdminLocation, AdminUser, Bill, Dated, HistEntry, StockLoc } from "../types";

export type Snapshot = z.infer<typeof SnapshotSchema>;
export type StockResponse = z.infer<typeof StockResponseSchema>;
const t = fromWireTime;
/**
 * The two things a document carries out of here: the `"HH:MM"` every table prints, and the
 * instant it was made from. Collapsing the instant on the way in was the whole of A1 - with
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

/**
 * A counter operator's snapshot is scoped to its own location, so the server omits the rest. The
 * store's map is exhaustive - an absent location is empty, not missing, or every `stock[loc][it]`
 * read would throw - over every location the master names, quarantine included. Read off `LOC`,
 * which `hydrateMaster` has just filled, rather than a list compiled into the bundle: an outlet the
 * super admin opened this morning is a location like any other.
 */
const stockOf = (s: Snapshot["stock"]): Record<StockLoc, Record<string, number>> =>
  ({ ...Object.fromEntries(Object.keys(LOC).map((l) => [l, {}])), ...s });

/** Server shape -> the store's shape. Times become "HH:MM", dates "DD-MMM-YYYY"; nothing else changes. */
export function applySnapshot(s: Snapshot): void {
  hydrateMaster({ items: s.items, locations: s.locations, prices: s.prices, priceLists: s.priceLists, menu: s.menu, users: s.users });
  // Who a bill may be charged to comes off the `payers` table the till has been checked
  // against since Phase 3, so a patient admitted this morning is billable without a release.
  hydrateRoster(s.roster);
  useApp.setState((prev) => ({
    user: s.user,
    // The catalogue is a module-level registry, not store state, so a snapshot that replaces
    // it changes nothing React can see. `applyItems` has always bumped this; a full snapshot -
    // an SSE `resync`, or the fallback refetch - brings new items the same way and must too.
    catalogVersion: prev.catalogVersion + 1,
    stock: stockOf(s.stock), rsv: s.rsv, ovr: s.ovr, prices: basePrices(), menu: s.menu,
    req: s.req.map((r) => ({ ...stamped(r), hist: hist(r.hist) })),
    tkt: s.tkt.map((x) => ({ ...x, hist: hist(x.hist) })),
    prq: s.prq.map((p) => ({ ...stamped(p), hist: hist(p.hist) })),
    po: s.po.map((o) => ({ ...stamped(o), eta: fromWireDate(o.eta), recv: o.recv ? t(o.recv) : undefined, hist: hist(o.hist) })),
    pord: s.pord.map((o) => ({ ...stamped(o), hist: hist(o.hist) })),
    batch: s.batch.map((b) => ({ ...stamped(b), bb: fromWireBestBefore(b.bb) })),
    bills: billed(s.bills),
    // `mfg`, `exp` and `invDate` are the vendor's printed dates and are shown raw.
    grn: s.grn.map(stamped),
    vendors: s.vendors,
    contracts: s.contracts.map((c) => ({ ...c, from: fromWireDate(c.from), to: fromWireDate(c.to) })),
    tickets: s.tickets.map((x) => ({ ...stamped(x), messages: x.messages.map((m) => ({ ...m, at: t(m.at) })) })),
    productReqs: s.productReqs.map(stamped),
    shopAsks: s.shopAsks.map(stamped),
    sales: s.sales, dayLabels: s.dayLabels,
    // ---- adjustments
    adjustments: s.adjustments.map(stamped),
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

/** A support ticket as the store holds it: times as "HH:MM", on the ticket and on every message,
 *  with the ticket's own instant kept beside its time. */
const supportRow = (x: Snapshot["tickets"][number]) => ({ ...stamped(x), messages: x.messages.map((m) => ({ ...m, at: t(m.at) })) });

/** GET /support/tickets -> the caller's own tickets. */
export function applySupportTickets(rows: Snapshot["tickets"]): void {
  useApp.setState({ tickets: rows.map(supportRow) });
}

/** GET /admin/support/tickets -> the desk's list of everybody's, in the same shape. */
export function applyDeskTickets(rows: Snapshot["tickets"]): void {
  useApp.setState({ deskTickets: rows.map(supportRow) });
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
  useApp.setState({ batch: batch.map((b) => ({ ...stamped(b), bb: fromWireBestBefore(b.bb) })) });
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

/** GET /prices -> every shelf list. The registry and the store's copy are the same lists -
 *  `basePrices()` is what every screen reads - so the registry is filled first and copied out. */
export function applyPrices(prices: Snapshot["prices"]): void {
  hydratePrices(prices);
  useApp.setState((s) => ({ prices: basePrices(), catalogVersion: s.catalogVersion + 1 }));
}

/** GET /price-lists -> the lists themselves (name, outlets), for the manager's management
 *  screen. Module-level like `PL`, so `catalogVersion` is the signal a screen reading
 *  `PRICE_LISTS` directly needs. */
export function applyPriceLists(priceLists: Snapshot["priceLists"]): void {
  hydratePriceLists(priceLists);
  useApp.setState((s) => ({ catalogVersion: s.catalogVersion + 1 }));
}

/** GET /locations -> the location master, in place, and a map for any location the stock does not
 *  carry yet. Module-level like `IT`, so `catalogVersion` is what tells a screen reading `LOC`
 *  directly - a newly opened outlet, a closed one, an outlet switched onto another price list -
 *  that the registry moved underneath it. */
export function applyLocations(locations: Snapshot["locations"]): void {
  hydrateLocations(locations);
  useApp.setState((prev) => ({ catalogVersion: prev.catalogVersion + 1, stock: stockOf(prev.stock) }));
}

/** GET /menus -> what each outlet lists. Like the catalogue, the registry is a module-level one
 *  (`MENU`), so `catalogVersion` is what tells a screen reading it directly that it moved. */
export function applyMenus(menu: Snapshot["menu"]): void {
  hydrateMenus(menu);
  useApp.setState((s) => ({ menu, catalogVersion: s.catalogVersion + 1 }));
}

// ---- payers ----
/** GET /roster -> the register the counter's payer picker reads. `PATIENTS`, `STAFF` and
 *  `DEPTS` are module-level registries like `IT` and `LOC`, not store state, so `catalogVersion`
 *  is what tells React the lists moved - the same signal `applyItems` bumps for the catalogue.
 *  The server only ever sends active rows, so a deactivated payer simply stops being offered at
 *  the till rather than needing a second filter here. */
export function applyRoster(r: Snapshot["roster"]): void {
  hydrateRoster(r);
  useApp.setState((s) => ({ catalogVersion: s.catalogVersion + 1 }));
}

// ---- admin: account management (a capability, not a role - root CLAUDE.md)
/** GET /admin/users -> every account, ordinary store state: nothing outside the admin page
 *  reads it, so there is no module-level registry to keep the identity of. */
export function applyAccounts(accounts: AdminUser[]): void { useApp.setState({ accounts }); }
/** GET /admin/locations -> the admin page's own list of every location but quarantine, with who
 *  is based at each. Nothing else reads this - an operational session reads `LOC` instead, kept
 *  live through `applyLocations` above. */
export function applyAdminLocations(adminLocations: AdminLocation[]): void { useApp.setState({ adminLocations }); }
/** GET /admin/actions -> the last fifty, times as "HH:MM" and the instant beside them like every
 *  other document here is stamped. `kind` picks which feed the rows land in: the account page's
 *  own, or the Outlets tab's. */
export function applyAdminActions(rows: AdminAction[], kind: "accounts" | "outlets" = "accounts"): void {
  useApp.setState(kind === "outlets" ? { outletActions: rows.map(stamped) } : { adminActions: rows.map(stamped) });
}

// ---- adjustments
/** GET /adjustments -> the register of write-offs and count-ups, times as "HH:MM" and the
 *  instant beside them, the way every other document here is stamped. Every adjustment names
 *  "adjustments" and "stock" in `changed`, so this and `applyStock` are what a write-off costs
 *  - the document and the shelf it corrected, not a whole snapshot. */
export function applyAdjustments(rows: Snapshot["adjustments"]): void {
  useApp.setState({ adjustments: rows.map(stamped) });
}
