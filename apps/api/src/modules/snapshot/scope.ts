import type { Adjustment, AdjustmentRequest, Batch, Bill, LocKey, PayerRoster, ProdOrder, ProductRequest, Role, ShopAsk, StockRequest, SupportTicket, Terms, Ticket } from "@rch/contract";
import { noTerms } from "../../lib/terms.js";
import type { Snapshot } from "./service.js";

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

/**
 * Who a bill was charged to is the one field on it that names a person: a consultant, a member
 * of staff or the ward carrying the cost, which is hospital data before it is F&B data.
 *
 * Two roles need it. The counter reads it back off its own till roll - it is what a customer
 * asks about when a bill is queried an hour later - and the manager reads it across the outlets,
 * because settling a credit account is their job. The kitchen, the central store and the buyer
 * do none of that. What they have always used bills for is the ledger behind them: `lines`,
 * which is untouched here, so every stock report still reads exactly what it did.
 *
 * The walk-in customer's name and phone, where the counter typed them, go the same way.
 *
 * So the bills travel whole minus the name. Not a filtered list - the store's reports count
 * bills as well as lines, and a store keeper whose totals quietly stopped matching the till's
 * would be worse off than one who simply cannot see whose account a sale went to.
 */
const READS_PAYERS: ReadonlySet<Who["role"]> = new Set(["counter", "manager"]);
export const scopePayers = (bills: Bill[], who: Who): Bill[] =>
  READS_PAYERS.has(who.role) ? bills : bills.map((b) => (b.payer || b.customerName || b.customerPhone
    ? { ...b, payer: undefined, customerName: undefined, customerPhone: undefined }
    : b));

/**
 * And the roster is the register those names come out of - every consultant, every member of
 * staff, every department, in one list. It is on the snapshot so that a till can offer
 * it while a bill is being taken; nobody who cannot take a bill has any use for it, and handing
 * the whole register to three roles that never open the payer picker was the larger half of the
 * same leak.
 */
export const scopeRoster = (roster: PayerRoster, who: Who): PayerRoster =>
  READS_PAYERS.has(who.role) ? roster : { staff: [], depts: [], doctors: [] };

/** And the rate card those names are charged against, cut the same way and for the same reason:
 *  what the hospital gives a consultant off is commercial information, and three of the five
 *  roles never take a bill. `noTerms()` is the empty card, the same shape, so a screen that
 *  reads it needs no special case. */
export const scopeTerms = (terms: Terms, who: Who): Terms =>
  READS_PAYERS.has(who.role) ? terms : noTerms();

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
 *  has no window on the production behind it - the snapshot has always sent them none. */
export const scopeBatches = (batch: Batch[], who: Who): Batch[] => (who.role !== "counter" ? batch : []);
/** Buying is not a counter operator's business. A requisition, an order, a goods receipt, a
 *  vendor and a rate contract are all read by the store, the kitchen, the manager and the
 *  buyer; a counter sees none of them, which is what their snapshot has always contained. */
export const scopeBuying = <T>(rows: T[], who: Who): T[] => (who.role !== "counter" ? rows : []);
/** The exception: a shop sees what it asked the central store to stock, and only that. */
export const scopeProductRequests = (rows: ProductRequest[], who: Who): ProductRequest[] =>
  who.role !== "counter" ? rows : rows.filter((p) => p.forLoc === who.loc);

/**
 * The six digits belong to whoever is collecting: they read them aloud and the sending location
 * types them in. Sending them to the sending location made the check theatre - the store's issue
 * desk printed the number three inches from the box that verifies it - and sending them to
 * anyone else is a credential in a snapshot for no reason at all.
 *
 * So: the OTP travels only while the ticket is still `Issued`, only to a caller standing at the
 * ticket's `to`, **and** only to a role that actually collects there. Everyone else reads "".
 * There is no way past a collector who is not there: the supervisor override that once handed
 * stock over without an OTP has been removed, so the ticket is cancelled and reissued instead.
 *
 * The role test is the second half and is not redundant. Location alone is not identity: the
 * outlet manager's own home location is an outlet (`rest` in the fixtures), so a location-only
 * check handed the manager the digits for every Issued Restaurant-bound ticket in the
 * snapshot - a credential for a handover they will never stand at. `COLLECTS` is the three
 * roles that are ever the receiving end of a ticket; a buyer and a manager are neither end of
 * one, and read "" wherever they happen to sit.
 */
const COLLECTS: ReadonlySet<Who["role"]> = new Set(["counter", "prod", "store"]);
export const redactOtps = (tkt: Ticket[], who: Who): Ticket[] =>
  tkt.map((t) => (t.st === "Issued" && t.to === who.loc && COLLECTS.has(who.role) ? t : { ...t, otp: "" }));

/**
 * Support is the one module all five roles share and every support write is
 * scoped "all (own)". The list is scoped the same way, by the user id in the token - `by` on the
 * wire is a display name and two people can share one.
 */
const scopeSupportTickets = (rows: SupportTicket[], who: { sub: string }, byUser: Map<string, string>): SupportTicket[] =>
  rows.filter((t) => byUser.get(t.id) === who.sub);

// ---- adjustments
/** The same cut `scopeStock` makes, on the document rather than on the balance: an adjustment is
 *  a correction to one shelf, so a counter operator sees the corrections to their own shelf and
 *  nobody else's. Everyone else sees the register whole - the store keeper writes off at the
 *  central store and at the rejected-goods shelf, the kitchen at the kitchen, the manager across
 *  the outlets, and each of them has to be able to read what the others did to a line they share.
 *  A counter raises none of these (the route is not theirs); they read what was done to them. */
export const scopeAdjustments = (rows: Adjustment[], who: Who): Adjustment[] =>
  who.role !== "counter" ? rows : rows.filter((a) => a.loc === who.loc);

/** A counter's own asks are their own outlet's; everyone else sees the queue, the same cut
 *  `scopeRequests` makes. */
export const scopeAdjustmentRequests = (rows: AdjustmentRequest[], who: Who): AdjustmentRequest[] =>
  who.role !== "counter" ? rows : rows.filter((r) => r.loc === who.loc);

/** A counter operator's world is their counter. Master data is never cut down; documents and stock are. */
export function scope(s: Snapshot, who: Who & { sub: string }, owners: Map<string, string>): Snapshot {
  // Five cuts apply to every role, not only to a counter: a support ticket is the caller's own,
  // a ticket's OTP is the collector's, and who a bill was charged to - with the register those
  // names come out of and the rate card they are charged against - belongs to the two roles that
  // bill people.
  const base: Snapshot = {
    ...s, tickets: scopeSupportTickets(s.tickets, who, owners), tkt: redactOtps(s.tkt, who),
    bills: scopePayers(s.bills, who), roster: scopeRoster(s.roster, who), terms: scopeTerms(s.terms, who),
  };
  if (who.role !== "counter") return base;
  const L = who.loc;
  return {
    ...base,
    ...scopeStock(base, who),
    menu: { [L]: base.menu[L] ?? [] },
    req: scopeRequests(base.req, who),
    tkt: scopeTickets(base.tkt, who),
    bills: scopeBills(base.bills, who),
    shopAsks: scopeShopAsks(base.shopAsks, who),
    productReqs: scopeProductRequests(base.productReqs, who),
    pord: scopeProdOrders(base.pord, who),
    batch: scopeBatches(base.batch, who),
    // `sales` is keyed by outlet, so handing it over whole tells a counter operator the whole
    // hospital's takings. Keep the shape (a record per day, matching dayLabels, which stay) and keep
    // only their own outlet - nothing at all if they are not on one.
    sales: base.sales.map((row) => (L in row ? { [L]: row[L] ?? 0 } : {})),
    prq: scopeBuying(base.prq, who), po: scopeBuying(base.po, who), grn: scopeBuying(base.grn, who),
    vendors: scopeBuying(base.vendors, who), contracts: scopeBuying(base.contracts, who),
    // ---- adjustments
    adjustments: scopeAdjustments(base.adjustments, who),
    // ---- adjustment requests
    adjReq: scopeAdjustmentRequests(base.adjReq, who),
  };
}
