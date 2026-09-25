import type { Adjustment, AdjustmentRequest, Batch, Bill, Feature, LocKey, PayerRoster, Permissions, ProdOrder, ProductRequest, Role, ShopAsk, StockRequest, SupportTicket, Terms, Ticket } from "@rch/contract";
import { KITCHEN } from "@rch/contract";
import { can, readsBills, readsWide, type ReadCollection } from "@rch/domain";
import { noTerms } from "../../lib/terms.js";
import type { Actor } from "../../plugins/rbac.js";
import type { Snapshot } from "./service.js";

/**
 * Who is asking: the desk they work (`role` in the token), where they are standing, and what their
 * role grants right now (`req.actor.perms`, resolved per request - never the token's). Every cut in
 * this file reads these three and nothing else.
 */
type Who = { desk: Role; loc: LocKey; perms: Permissions };
export const whoOf = (a: Actor): Who => ({ desk: a.role, loc: a.loc, perms: a.perms });

/**
 * Whether the caller's reads of one collection are cut to their own location. Each collection is
 * widened by its own features (`readsWide`, @rch/domain): every outlet widens them all, Items &
 * stock or the ledger widens the shelves but not the till roll, Approvals the documents it decides.
 * The store, kitchen and purchasing desks are never cut. For the seeded roles that is exactly "the
 * counter operator", as it always was: the Outlet Manager holds every outlet.
 */
const cut = (who: Who, c: ReadCollection): boolean => !readsWide(who.desk, who.perms, c);
const any = (who: Who, fs: readonly Feature[]): boolean => fs.some((f) => can(who.perms, f));
/** The three ledger maps, together: GET /stock's whole body and three of the snapshot's fields. */
export type StockPart = Pick<Snapshot, "stock" | "rsv" | "ovr">;

/** A counter operator sees their own counter's ledger and nobody else's - and the kitchen's
 *  switches, because the kitchen switching an on/off-only product off takes it off this till too
 *  (`availOf`), and a till that could not see that switch would offer what the sale refuses. */
export function scopeStock(part: StockPart, who: Who): StockPart {
  if (!cut(who, "stock")) return part;
  const L = who.loc;
  const own = (e: [string, unknown][]) => e.filter(([k]) => k.startsWith(`${L}:`));
  return {
    stock: { [L]: part.stock[L] ?? {} } as Snapshot["stock"],
    rsv: Object.fromEntries(own(Object.entries(part.rsv))) as Snapshot["rsv"],
    ovr: Object.fromEntries(Object.entries(part.ovr).filter(([k]) => k.startsWith(`${L}:`) || k.startsWith(`${KITCHEN}:`))) as Snapshot["ovr"],
  };
}

/**
 * Takings are not master data: a counter operator gets their own till roll, not the hospital's.
 * Only every outlet widens it - a ledger or a price list is no reason to read other counters'
 * customers - and a counter or manager role without Bills reads no till roll at all
 * (`readsBills`). The back-office desks read it whole, as they always have: their reports count
 * the lines.
 */
export const scopeBills = (bills: Bill[], who: Who): Bill[] =>
  !readsBills(who.desk, who.perms) ? [] : !cut(who, "bills") ? bills : bills.filter((b) => b.loc === who.loc);
/** The takings by day and outlet, cut exactly as the bills are: keep the shape (a record per day,
 *  matching `dayLabels`, which stay) and keep only the caller's own outlet - nothing at all if they
 *  are not on one, or cannot read the till roll. */
const scopeSales = (sales: Snapshot["sales"], who: Who): Snapshot["sales"] => {
  if (!readsBills(who.desk, who.perms)) return sales.map(() => ({}));
  if (!cut(who, "bills")) return sales;
  const L = who.loc;
  return sales.map((row) => (L in row ? { [L]: row[L] ?? 0 } : {}));
};

/**
 * Who a bill was charged to is the one field on it that names a person: a consultant, a member
 * of staff or the ward carrying the cost, which is hospital data before it is F&B data.
 *
 * Three features need the names. Bills (`billing`, the counter's till and the manager's view of
 * it) reads them back off the till roll - it is what a customer asks about when a bill is queried
 * an hour later - and the two halves of Credit read the register and the rate card: discounts and
 * limits (`credit`) are set per person, and receivables and settlements (`settlements`) are kept
 * per person. Of the seeded roles that is the counter and the manager, as it always was. The kitchen, the central store and the buyer
 * do none of that. What they have always used bills for is the ledger behind them: `lines`,
 * which is untouched here, so every stock report still reads exactly what it did.
 *
 * The walk-in customer's name and phone, where the counter typed them, go the same way.
 *
 * So the bills travel whole minus the name. Not a filtered list - the store's reports count
 * bills as well as lines, and a store keeper whose totals quietly stopped matching the till's
 * would be worse off than one who simply cannot see whose account a sale went to.
 */
const readsPayers = (who: Who): boolean => any(who, ["billing", "credit", "settlements"]);
export const scopePayers = (bills: Bill[], who: Who): Bill[] =>
  readsPayers(who) ? bills : bills.map((b) => (b.payer || b.customerName || b.customerPhone
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
  readsPayers(who) ? roster : { staff: [], depts: [], doctors: [] };

/** And the rate card those names are charged against, cut the same way and for the same reason:
 *  what the hospital gives a consultant off is commercial information, and three of the five
 *  roles never take a bill. `noTerms()` is the empty card, the same shape, so a screen that
 *  reads it needs no special case. */
export const scopeTerms = (terms: Terms, who: Who): Terms =>
  readsPayers(who) ? terms : noTerms();

/** A counter's requests are their own outlet's; everyone else sees the desk they work. */
export const scopeRequests = (req: StockRequest[], who: Who): StockRequest[] =>
  !cut(who, "requests") ? req : req.filter((r) => r.from === who.loc);
/** Either end of the movement: a counter sees what leaves them and what is coming to them. */
export const scopeTickets = (tkt: Ticket[], who: Who): Ticket[] =>
  !cut(who, "tickets") ? tkt : tkt.filter((t) => t.from === who.loc || t.to === who.loc);
/** Shop to shop: the asker and the shop being asked, nobody in between. */
export const scopeShopAsks = (asks: ShopAsk[], who: Who): ShopAsk[] =>
  !cut(who, "shopAsks") ? asks : asks.filter((a) => a.from === who.loc || a.to === who.loc);
/** The kitchen's board belongs to the kitchen; an outlet sees the orders it raised itself. */
export const scopeProdOrders = (pord: ProdOrder[], who: Who): ProdOrder[] =>
  !cut(who, "prodOrders") ? pord : pord.filter((o) => o.from === who.loc);
/**
 * The batch log and the buying documents are the back office's, and are cut by desk and then by
 * feature - not by the counter cut above, because reading every outlet's till is no reason to read
 * the kitchen's production or the hospital's purchasing.
 *
 * - The four back-office desks (manager, store, kitchen, purchasing) read both whole, whatever
 *   their role holds, exactly as each always has: the store's on-order figures, requisition
 *   progress and lot register, the kitchen's batch log and the manager's view over all of it lean
 *   on them, and none of it names a person.
 * - A counter-desk role reads none of either - what a counter's snapshot has always contained -
 *   unless it has been given a screen that is about them. Buying (requisitions, orders, goods
 *   receipts, vendors, rate contracts) comes with any Purchasing feature, Goods receipt or
 *   Inventory. The batch log comes with any Kitchen feature or Items & stock, the hospital-wide
 *   stock screen.
 *
 * A counter desk can be given only some of these (`FEATURES` in @rch/domain says which); the rule
 * names them all so that it reads the same whatever the grant table allows next.
 */
const BUYING: readonly Feature[] = ["requisitions", "procurement_list", "purchase_orders", "rate_contracts", "vendors", "goods_receipt", "inventory"];
const BATCHES: readonly Feature[] = ["kitchen_orders", "make_distribute", "kitchen_requests", "kitchen_tickets", "kitchen_stock", "items_stock"];
export const scopeBatches = (batch: Batch[], who: Who): Batch[] =>
  (who.desk !== "counter" || any(who, BATCHES) ? batch : []);
export const scopeBuying = <T>(rows: T[], who: Who): T[] =>
  (who.desk !== "counter" || any(who, BUYING) ? rows : []);
/** The exception: a shop sees what it asked the central store to stock, and only that. */
export const scopeProductRequests = (rows: ProductRequest[], who: Who): ProductRequest[] =>
  !cut(who, "productReqs") ? rows : rows.filter((p) => p.forLoc === who.loc);

/**
 * The six digits belong to whoever is collecting: they read them aloud and the sending location
 * types them in. Sending them to the sending location made the check theatre - the store's issue
 * desk printed the number three inches from the box that verifies it - and sending them to
 * anyone else is a credential in a snapshot for no reason at all.
 *
 * So: the OTP travels only while the ticket is still `Issued`, only to a caller standing at the
 * ticket's `to`, **and** only to a role that actually collects there - one that can work a ticket
 * desk (Pick tickets, Kitchen pick tickets or the Issue desk, at edit). Everyone else reads "".
 * There is no way past a collector who is not there: the supervisor override that once handed
 * stock over without an OTP has been removed, so the ticket is cancelled and reissued instead.
 *
 * The role test is the second half and is not redundant. Location alone is not identity: the
 * outlet manager's own home location is an outlet (`rest` in the fixtures), so a location-only
 * check handed the manager the digits for every Issued Restaurant-bound ticket in the
 * snapshot - a credential for a handover they will never stand at. `COLLECTS` is the three
 * ticket features, the doors a receive goes through (`handover`/`receiveTicket` need one of them
 * at edit); the seeded counter, kitchen and store roles hold one each, and the seeded manager and
 * buyer hold none, so they read "" wherever they happen to sit.
 */
const COLLECTS: readonly Feature[] = ["outlet_tickets", "kitchen_tickets", "issue_desk"];
const collects = (who: Who): boolean => COLLECTS.some((f) => can(who.perms, f, "edit"));
export const redactOtps = (tkt: Ticket[], who: Who): Ticket[] =>
  tkt.map((t) => (t.st === "Issued" && t.to === who.loc && collects(who) ? t : { ...t, otp: "" }));

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
 *  nobody else's. A role that reads the shelves across the hospital sees the register whole - the store keeper writes off at the
 *  central store and at the rejected-goods shelf, the kitchen at the kitchen, the manager across
 *  the outlets, and each of them has to be able to read what the others did to a line they share.
 *  A counter raises none of these (the route is not theirs); they read what was done to them. */
export const scopeAdjustments = (rows: Adjustment[], who: Who): Adjustment[] =>
  !cut(who, "stock") ? rows : rows.filter((a) => a.loc === who.loc);

/** A counter's own asks are their own outlet's; everyone else sees the queue, the same cut
 *  `scopeRequests` makes. */
export const scopeAdjustmentRequests = (rows: AdjustmentRequest[], who: Who): AdjustmentRequest[] =>
  !cut(who, "adjReq") ? rows : rows.filter((r) => r.loc === who.loc);

/** A counter operator's world is their counter - unless their role widens a collection (`cut`).
 *  Master data is never cut down; documents, stock and takings are, each on its own rule. */
export function scope(s: Snapshot, who: Who & { sub: string }, owners: Map<string, string>): Snapshot {
  // Five cuts apply to every role, not only to a counter: a support ticket is the caller's own,
  // a ticket's OTP is the collector's, and who a bill was charged to - with the register those
  // names come out of and the rate card they are charged against - belongs to a role that bills
  // people or keeps their accounts.
  const L = who.loc;
  const stock = scopeStock(s, who);
  return {
    ...s,
    ...stock,
    tickets: scopeSupportTickets(s.tickets, who, owners),
    menu: cut(who, "stock") ? { [L]: s.menu[L] ?? [] } : s.menu,
    req: scopeRequests(s.req, who),
    tkt: redactOtps(scopeTickets(s.tkt, who), who),
    bills: scopePayers(scopeBills(s.bills, who), who),
    sales: scopeSales(s.sales, who),
    roster: scopeRoster(s.roster, who),
    terms: scopeTerms(s.terms, who),
    shopAsks: scopeShopAsks(s.shopAsks, who),
    productReqs: scopeProductRequests(s.productReqs, who),
    pord: scopeProdOrders(s.pord, who),
    batch: scopeBatches(s.batch, who),
    prq: scopeBuying(s.prq, who), po: scopeBuying(s.po, who), grn: scopeBuying(s.grn, who),
    vendors: scopeBuying(s.vendors, who), contracts: scopeBuying(s.contracts, who),
    // ---- adjustments
    adjustments: scopeAdjustments(s.adjustments, who),
    // ---- adjustment requests
    adjReq: scopeAdjustmentRequests(s.adjReq, who),
  };
}
