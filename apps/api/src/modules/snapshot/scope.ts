import type { Batch, Bill, LocKey, ProdOrder, ProductRequest, Role, ShopAsk, StockRequest, Ticket } from "@rch/contract";
import type { Snapshot } from "./service.js";

/** The columns of `sales`, in order — mirrors OUTLET_COLS in readers/documents.ts. */
const OUTLET_COLS: readonly string[] = ["rest", "coffee", "kiosk"];

/** Who is asking. The snapshot and the two standalone reads all cut by the same two fields. */
export type Who = { role: Role; loc: LocKey };
/** The three ledger maps, together: GET /stock's whole body and three of the snapshot's fields. */
export type StockPart = Pick<Snapshot, "stock" | "rsv" | "ovr">;

/** A counter operator sees their own counter's ledger and nobody else's. */
export function scopeStock(part: StockPart, who: Who): StockPart {
  if (who.role !== "counter") return part;
  const L = who.loc;
  const own = (e: [string, unknown][]) => e.filter(([k]) => k.startsWith(`${L}:`));
  return {
    stock: { [L]: part.stock[L] ?? {} } as Snapshot["stock"],
    rsv: Object.fromEntries(own(Object.entries(part.rsv))) as Snapshot["rsv"],
    ovr: Object.fromEntries(own(Object.entries(part.ovr))) as Snapshot["ovr"],
  };
}

/** Takings are not master data: a counter operator gets their own till roll, not the hospital's. */
export const scopeBills = (bills: Bill[], who: Who): Bill[] =>
  who.role !== "counter" ? bills : bills.filter((b) => b.loc === who.loc);

/** A counter's requests are their own outlet's; everyone else sees the desk they work. */
export const scopeRequests = (req: StockRequest[], who: Who): StockRequest[] =>
  who.role !== "counter" ? req : req.filter((r) => r.from === who.loc);
/** Either end of the movement: a counter sees what leaves them and what is coming to them. */
export const scopeTickets = (tkt: Ticket[], who: Who): Ticket[] =>
  who.role !== "counter" ? tkt : tkt.filter((t) => t.from === who.loc || t.to === who.loc);
/** Shop to shop: the asker and the shop being asked, nobody in between. */
export const scopeShopAsks = (asks: ShopAsk[], who: Who): ShopAsk[] =>
  who.role !== "counter" ? asks : asks.filter((a) => a.from === who.loc || a.to === who.loc);
/** The kitchen's board belongs to the kitchen; an outlet sees the orders it raised itself. */
export const scopeProdOrders = (pord: ProdOrder[], who: Who): ProdOrder[] =>
  who.role !== "counter" ? pord : pord.filter((o) => o.from === who.loc);
/** The batch log is the kitchen's own record of what it made. A counter sells the output and
 *  has no window on the production behind it — the snapshot has always sent them none. */
export const scopeBatches = (batch: Batch[], who: Who): Batch[] => (who.role !== "counter" ? batch : []);
/** Buying is not a counter operator's business. A requisition, an order, a goods receipt, a
 *  vendor and a rate contract are all read by the store, the kitchen, the manager and the
 *  buyer; a counter sees none of them, which is what their snapshot has always contained. */
export const scopeBuying = <T>(rows: T[], who: Who): T[] => (who.role !== "counter" ? rows : []);
/** The exception: a shop sees what it asked the central store to stock, and only that. */
export const scopeProductRequests = (rows: ProductRequest[], who: Who): ProductRequest[] =>
  who.role !== "counter" ? rows : rows.filter((p) => p.forLoc === who.loc);

/** A counter operator's world is their counter. Master data is never cut down; documents and stock are. */
export function scope(s: Snapshot, who: Who & { sub: string }): Snapshot {
  if (who.role !== "counter") return s;
  const L = who.loc;
  const mine = (x: { by: string }) => x.by === s.user.n;
  // `sales` is one column per outlet, so handing it over whole tells a counter operator the
  // whole hospital's takings. Keep the shape (a row per day, matching dayLabels, which stay)
  // and keep only their own column — none at all if they are not on an outlet.
  const col = OUTLET_COLS.indexOf(L);
  return {
    ...s,
    ...scopeStock(s, who),
    menu: { [L]: s.menu[L] ?? [] },
    req: scopeRequests(s.req, who),
    tkt: scopeTickets(s.tkt, who),
    bills: scopeBills(s.bills, who),
    shopAsks: scopeShopAsks(s.shopAsks, who),
    tickets: s.tickets.filter(mine),
    productReqs: scopeProductRequests(s.productReqs, who),
    pord: scopeProdOrders(s.pord, who),
    batch: scopeBatches(s.batch, who),
    sales: s.sales.map((row) => (col === -1 ? [] : [row[col] ?? 0])),
    prq: scopeBuying(s.prq, who), po: scopeBuying(s.po, who), grn: scopeBuying(s.grn, who),
    vendors: scopeBuying(s.vendors, who), contracts: scopeBuying(s.contracts, who),
  };
}
