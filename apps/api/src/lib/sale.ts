// The sale: one bill at one outlet, priced, covered, numbered, written and posted. Two callers -
// the till (`modules/pos`'s `pay`) and a QR order's capture (`modules/qr`) - and one body, so a
// QR bill is exactly the bill a till would have printed: same prices, same cover checks, same
// register session, same GST split. The arithmetic is `planBill` in packages/domain.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Bill, BillSource, Changed, Item, PayerKind, Tender, WriteResponse } from "@rch/contract";
import { avail, availOf, breachesCredit, creditBreachMessage, fq, money as inr, normalizePhone, partyOf, phoneRefusal, payerKindForTender, PARTY_LABEL, planBill, priceOf, round3, type Master, type OvrMap, type Prices, type RsvMap, type StockMap } from "@rch/domain";
import { availabilityOverrides, billLines, bills, locationItems, payers, priceListItems, reservations, stockBalances, users } from "../db/schema/index.js";
import { lockPayerCredit, outstandingFor } from "./credit.js";
import type { Reader, Tx } from "./db.js";
import { NotFoundError } from "./errors.js";
import { allocateId } from "./ids.js";
import { lockBalances, postMoves } from "./ledger.js";
import { assertOpen, lockLocation } from "./locations.js";
import { loadMaster } from "./master.js";
import { sessionFor } from "./register.js";
import { reservedAt } from "./reservations.js";
import { assertRule } from "./rules.js";
import { termsFor } from "./terms.js";
import { PAYER_LABEL, toWireBill, type BillLineRow, type BillRow } from "./wire.js";

/** Money is stored and read at two decimals; `planBill` totals at full precision so the tax
 *  split is derived from the real amounts, not from a rounded one. */
const money = (n: number): number => Math.round(n * 100) / 100;

// ---- what an outlet can sell right now

/**
 * Everything a sale - or a menu - reads about one outlet: the master, its menu, its shelf, what
 * is held on it, what is switched off, and every price list. One shelf, not the ledger: the
 * snapshot readers pull every location because a screen lists them all, and a till only ever
 * needs its own. Read inside the caller's transaction, one query after another (one client).
 *
 * Nothing here takes a lock. A sale reads these before its locks to give a friendly refusal
 * that can name the item and the number left, then re-reads the shelf under `lockBalances`,
 * which is the guarantee.
 */
export type Sellable = {
  loc: string; locName: string; master: Master;
  menu: Set<string>; stock: StockMap; rsv: RsvMap; ovr: OvrMap; prices: Prices;
};

export async function sellableAt(db: Reader, loc: string): Promise<Sellable> {
  const master = await loadMaster(db);
  const menu = new Set((await db.select({ itemKey: locationItems.itemKey }).from(locationItems).where(eq(locationItems.loc, loc))).map((r) => r.itemKey));
  const byItem: Record<string, number> = {};
  for (const r of await db.select().from(stockBalances).where(eq(stockBalances.loc, loc))) byItem[r.itemKey] = r.onHand;
  // Open reservations only: a released one is stock the counter may sell again.
  const held = await db.select({ itemKey: reservations.itemKey, qty: sql<string>`round(sum(${reservations.qty}), 3)` })
    .from(reservations).where(and(eq(reservations.loc, loc), isNull(reservations.releasedAt))).groupBy(reservations.itemKey);
  const off = await db.select().from(availabilityOverrides).where(eq(availabilityOverrides.loc, loc));
  // Every list: which one a location charges from is the master's business (`priceOf`).
  const prices: Prices = {};
  for (const r of await db.select().from(priceListItems)) (prices[r.listId] ??= {})[r.itemKey] = r.price;
  return {
    loc, locName: master.locations[loc]?.n ?? loc, master, menu,
    stock: { [loc]: byItem },
    rsv: Object.fromEntries(held.map((r) => [`${loc}:${r.itemKey}`, Number(r.qty)])),
    ovr: Object.fromEntries(off.map((r) => [`${loc}:${r.itemKey}`, r.reason])),
    prices,
  };
}

/** How many of `it` the location could sell right now: the free units of a stocked item. A
 *  made-to-order item holds no stock and moves none (`planBill`), so nothing caps it here -
 *  only its switch, which `availOf` reads. */
function coverOf(s: Sellable, it: string): number {
  if (s.master.items[it]?.t === "MTO") return Number.POSITIVE_INFINITY;
  return avail(s.stock, s.rsv, s.loc, it);
}

/** One line of an outlet's menu as a customer could buy it: the till's price capped at the
 *  printed MRP (`priceOf`), whether it is available and why not, and how many are free. */
export type SellableLine = {
  it: string; item: Item; price: number; mrp?: number;
  available: boolean; why?: string; cover: number;
};

/**
 * The outlet's menu, item by item, in name order: every listed item the master still sells.
 * A line with no price at this outlet reads as unavailable, with the same reason the till would
 * refuse it for. The QR menu is this list; a sale refuses on the same four checks
 * (`assertSellable`).
 */
export function menuOf(s: Sellable): SellableLine[] {
  const out: SellableLine[] = [];
  for (const it of s.menu) {
    const item = s.master.items[it];
    if (!item) continue;
    const a = availOf(s.master, s.stock, s.rsv, s.ovr, s.loc, it);
    const price = priceOf(s.master, s.prices, s.loc, it).p;
    const cover = coverOf(s, it);
    const why = !a.ok ? a.why : price > 0 ? undefined : `${item.n} has no price at ${s.locName}`;
    out.push({ it, item, price, mrp: item.mrp, available: a.ok && price > 0, why, cover });
  }
  return out.sort((a, b) => a.item.n.localeCompare(b.item.n) || a.it.localeCompare(b.it));
}

/**
 * Refuse a cart the outlet cannot sell, naming the first item that fails and why: an item the
 * master does not know (404), one not on this outlet's menu, one switched off or sold out, one
 * whose free units do not cover the cart, and one with no price here. The outlet must be on a
 * price list at all - checked first, before any item. These are the friendly refusals; the
 * re-read under the balance locks in `postSale` is the guarantee.
 */
export function assertSellable(s: Sellable, cart: Record<string, number>): void {
  const { master, loc, locName } = s;
  // A new outlet opens on no list at all (the manager prices it from the grid), and `priceOf`
  // reads that as ₹0 rather than crashing. Refuse the whole cart here, before the per-item loop
  // and well before any lock or id, rather than let a ₹0 bill through while still taking the
  // stock off the shelf.
  assertRule(master.locations[loc]?.list, `Refused - ${locName} is on no price list; attach one from Prices before selling`);
  for (const it of Object.keys(cart)) {
    const item = master.items[it];
    if (!item) throw new NotFoundError(`There is no item ${it}.`);
    assertRule(s.menu.has(it), `${item.n} is not listed at ${locName}`);
    const a = availOf(master, s.stock, s.rsv, s.ovr, loc, it);
    assertRule(a.ok, `${item.n} is not available at ${locName} - ${a.why}`);
    const cover = coverOf(s, it);
    assertRule(cover >= cart[it], `Only ${fq(cover, item.u)} ${item.u} of ${item.n} left at ${locName}`);
    // The outlet has a list (checked above); this item may still be missing from it - a product
    // listed at the counter before the manager ever priced it there.
    assertRule(priceOf(master, s.prices, loc, it).p > 0, `Refused - ${item.n} has no price at ${locName}`);
  }
}

/** A cart is a bag of scans: the same item read twice is one line of two, and the cover check
 *  has to see the total, not each half. */
export function cartOf(lines: readonly { it: string; qty: number }[]): Record<string, number> {
  const cart: Record<string, number> = {};
  for (const l of lines) cart[l.it] = round3((cart[l.it] ?? 0) + l.qty);
  return cart;
}

// ---- the sale itself

export type SaleInput = {
  loc: string;
  /** Whose bill it is: the signed-in operator at a till, the system account for a QR capture
   *  (`lib/system-users.ts`). */
  operatorId: string;
  lines: readonly { it: string; qty: number }[];
  tender: Tender;
  /** Whose account a tender that takes no money now lands on. The name is only what the till
   *  showed - the bill carries the roster's. */
  payer?: { kind: PayerKind; id: string; name: string };
  /** The walk-in customer, both optional. The phone is stored as its ten digits. */
  customer?: { name?: string | null; phone?: string | null };
  source: BillSource;
  /** The QR order this bill fills; required with `source: "qr"` (`bills_source_ck`). */
  qrOrderId?: string;
};

/** Read back after `postMoves` has taken the locks - the only number a sale may trust. */
async function onHandAt(tx: Tx, loc: string, itemKeys: string[]): Promise<Record<string, number>> {
  if (itemKeys.length === 0) return {};
  const rows = await tx.select().from(stockBalances)
    .where(and(eq(stockBalances.loc, loc), inArray(stockBalances.itemKey, itemKeys))).orderBy(asc(stockBalances.itemKey));
  return Object.fromEntries(rows.map((r) => [r.itemKey, r.onHand]));
}

/**
 * One sale, inside the caller's transaction: price it, lock the shelves it will move, refuse it
 * if they cannot cover it, number it, write it, and post the moves. The friendly refusals read
 * the balances before the locks - so they can name the item and the number left - and the read
 * under the locks is the guarantee, because between the two a second till may have sold the same
 * last unit. A refusal throws, and the caller's transaction rolls the whole bill back.
 *
 * **Lock order**: the outlet (`FOR SHARE`), then its register session, then the payer's credit
 * lock where there is a payer, then the shelves, then the bill number - last, after the balance
 * locks rather than before them; the comment on `allocateId` below says why that inversion is
 * safe here and what it buys. A caller that locks a document of its own (a QR capture locks its
 * order `FOR UPDATE`) takes it before calling this, in the documents tier.
 *
 * Returns the bill, what changed, and the operator's sentence. It does not announce: the caller
 * adds what it changed besides (a QR capture adds `qrOrders`) and calls `emitChanged` once.
 */
export async function postSale(tx: Tx, input: SaleInput): Promise<WriteResponse<Bill>> {
  const { loc, operatorId } = input;
  // The outlet first - it is the documents tier - so a close waits for this sale to commit, or
  // this sale reads the outlet closed.
  assertOpen(await lockLocation(tx, loc));
  // Then the register's open session, opened here if the outlet has none - the first sale after
  // a Z is what starts the next business day, and nothing else does. It is a document too, so it
  // is taken in the documents tier: after the outlet's row and before the bill number and every
  // shelf. Held `FOR SHARE`, so a Z-close waits for this sale to commit rather than counting half
  // of it, and a sale that begins after the close reads no open session and opens the next
  // (`lib/register.ts`).
  const session = await sessionFor(tx, loc, operatorId);
  const cart = cartOf(input.lines);
  // `PayBodySchema.lines` is `.min(1)` with a positive `qty` (and a QR order's lines are the
  // same), so a cart that folded to nothing cannot reach here: there is no empty-cart rule to
  // state a second time.

  // The walk-in customer, both optional. A blank box is no customer rather than an empty string
  // on the bill, and a phone is stored as its ten digits so one number is one person.
  const customerName = input.customer?.name || null;
  const rawPhone = input.customer?.phone?.trim() ?? "";
  const customerPhone = rawPhone ? normalizePhone(rawPhone) : null;
  assertRule(!rawPhone || customerPhone, phoneRefusal(rawPhone));

  // A tender that is not money changing hands has to name whose account it lands on, and the
  // payer has to be of the kind the tender means (`payerKindForTender`, @rch/domain - one table,
  // because a tender that accepts the wrong kind of payer is a bill nothing later counts: a staff
  // credit posted to a consultant is invisible to the ceiling below and to every receivables
  // figure the manager reads).
  const needKind = payerKindForTender(input.tender);
  const needLabel = needKind ? PAYER_LABEL[needKind] : "";
  assertRule(!(needKind && !input.payer), `Choose a ${needLabel} before taking a ${input.tender.toLowerCase()}`);
  assertRule(!needKind || input.payer?.kind === needKind,
    `Choose a ${needLabel} for a ${input.tender.toLowerCase()} - ${input.payer?.name} is not one`);

  // And the payer has to be somebody the hospital already knows. The till sends a name along
  // with the id, but the name written on the bill is the roster's: a mistyped id is a second
  // account with its own untouched credit ceiling, and a name the counter typed is a balance
  // nobody can settle because nobody can find whose it is. Only an active roster row answers: a
  // consultant who no longer visits is not somebody a new balance may be run up against.
  const roster = input.payer
    ? (await tx.select({ name: payers.name }).from(payers)
      .where(and(eq(payers.kind, input.payer.kind), eq(payers.id, input.payer.id), eq(payers.active, true))))[0]
    : undefined;
  if (input.payer) assertRule(roster, `There is no ${PAYER_LABEL[input.payer.kind]} ${input.payer.id} on the roster`);
  const payer = input.payer && roster ? { kind: input.payer.kind, id: input.payer.id, name: roster.name } : undefined;

  const s = await sellableAt(tx, loc);
  const { master, locName, prices } = s;
  assertSellable(s, cart);

  // What this party is charged. Read inside the transaction, so the bill is priced against the
  // rate card this transaction commits against - a manager changing the doctors' rate in the same
  // instant either lands before this sale or after it, never half way through it. The till
  // previews the same number off the snapshot; the server decides it.
  const party = partyOf(payer);
  const terms = await termsFor(tx, party, payer);
  const plan = planBill(master, prices, loc, cart, terms.pct);
  const at = new Date();
  // A tender that takes no money now runs up a balance somebody settles later. The ceiling is on
  // what is still **unsettled**, not on a calendar month: somebody who cleared their account
  // yesterday has their room back today. Checked here rather than only on the counter's screen -
  // a second tab or a stale page would otherwise walk straight past a disabled button.
  if (payer) {
    // Read the balance under a lock on the person, not merely read it: two tills selling to one
    // person in the same instant would otherwise both see the room that existed before either
    // wrote, and both fit under a ceiling only one of them fits under.
    await lockPayerCredit(tx, payer.kind, payer.id);
    // One query, three callers: this refusal, `GET /reports/credit/:kind/:id` and the manager's
    // receivables list (apps/api/src/lib/credit.ts).
    const { outstanding } = await outstandingFor(tx, payer.kind, payer.id);
    assertRule(
      !breachesCredit(outstanding, plan.tot, terms.limit),
      // Only reached when there is a limit, which is what `breachesCredit` answers `false` for
      // when there is not - so the non-null assertion here is the same condition.
      creditBreachMessage(outstanding, plan.tot, payer.name, terms.limit ?? 0),
      { outstanding, limit: terms.limit },
    );
  }
  // What the sale will take off each shelf, folded the way postMoves folds it. A made-to-order
  // line moves nothing, so a bill of nothing else locks and reads no shelf. Same refusal as the
  // pre-check above: that one is friendlier, this one is the guarantee.
  //
  // Holds sit on outlet shelves too - a shop transfer or a granted shop ask keeps stock at a
  // counter without moving it - so "short" means on hand less what is held, not merely negative.
  // Both numbers are read again here rather than reused from the pre-check, and read *after*
  // `lockBalances`: every path that holds stock takes those same locks first (see
  // apps/api/src/lib/ledger.ts), so while this transaction holds them nothing new can be sold or
  // held on these shelves and this read is the last word.
  const took = new Map<string, number>();
  for (const m of plan.moves) took.set(m.it, round3((took.get(m.it) ?? 0) + -m.qty));
  const moved = [...took.keys()];
  await lockBalances(tx, moved.map((it) => ({ loc, it })));
  const onHand = await onHandAt(tx, loc, moved);
  const heldNow = await reservedAt(tx, loc, moved);
  for (const [it, sold] of took) {
    const item = master.items[it];
    const unit = item?.u ?? "nos";
    const free = round3((onHand[it] ?? 0) - (heldNow[`${loc}:${it}`] ?? 0));
    assertRule(free >= sold, `Only ${fq(Math.max(0, free), unit)} ${unit} of ${item?.n ?? it} left at ${locName}`);
  }

  // The number, last - deliberately after the balance locks rather than before them, which is
  // the one place in this server where an id is not taken ahead of a shelf.
  //
  // `allocateId(tx, "bill"` has exactly one caller, this line - the till and a QR capture both
  // reach it through `postSale` - so no second writer can ever take the `bill` sequence row before
  // a balance row and meet this one head on: the cycle a lock order exists to prevent needs two
  // writers taking the same two locks in opposite orders, and there is no other writer of this row
  // at all. What taking it earlier did cost was real - a till queued behind a shelf sat on the one
  // row every till in the hospital draws its bill number from, so one slow sale at one counter
  // froze the rest. Keep this line where it is, and keep it the last thing before the bill is
  // written.
  const no = await allocateId(tx, "bill", at);
  const [head]: BillRow[] = await tx.insert(bills).values({
    no, loc, operatorId, total: money(plan.tot), tax: money(plan.tax), at, tender: input.tender,
    // Which Z will account for this bill, decided here and not by a clock: the business day is
    // Z-to-Z, and a sale that commits a moment either side of a close must fall inside exactly
    // one of them.
    sessionId: session.id,
    payerKind: payer?.kind ?? null, payerId: payer?.id ?? null, payerName: payer?.name ?? null,
    // The rate as well as the rupees: the rate card moves, and a bill has to be able to say what
    // it was charged at long after somebody changed it.
    discountPct: terms.pct, discount: money(plan.disc),
    customerName, customerPhone,
    source: input.source, qrOrderId: input.qrOrderId ?? null,
  }).returning();
  // Sorted on the way out: `toWireBill` prints the lines in the order they were scanned, and
  // RETURNING makes no promise about row order.
  const lines: BillLineRow[] = plan.lines.length === 0 ? [] : (await tx.insert(billLines)
    .values(plan.lines.map((l, lineNo) => ({ billNo: no, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate }))).returning())
    .sort((a, b) => a.lineNo - b.lineNo);
  await postMoves(tx, plan.moves.map((m) => ({ ...m, kind: "sale" as const, refType: "bill", refId: no, by: operatorId, at })));

  // And once more with the moves actually posted. It can never fire today - the cover check above
  // ran under these same locks and nothing can have written behind it - and it is kept because
  // every negative-going move re-reads what it moved, and this is what would catch the next caller
  // that reads a balance before it locks it.
  const settled = await onHandAt(tx, loc, moved);
  const stillHeld = await reservedAt(tx, loc, moved);
  for (const [it, sold] of took) {
    const item = master.items[it];
    const unit = item?.u ?? "nos";
    const free = round3((settled[it] ?? 0) - (stillHeld[`${loc}:${it}`] ?? 0));
    assertRule(free >= 0, `Only ${fq(Math.max(0, round3(free + sold)), unit)} ${unit} of ${item?.n ?? it} left at ${locName}`);
  }

  const [operator] = await tx.select({ name: users.name, colour: users.colour }).from(users).where(eq(users.id, operatorId));
  const result = toWireBill(head, lines, { name: operator?.name ?? operatorId, colour: operator?.colour ?? "#64748B" });
  const total = money(plan.tot).toFixed(2);
  // The concession is named where there was one, and named as the rate rather than only the
  // rupees: "20% off" is the thing the operator has to be able to check at a glance against what
  // the person in front of them expected.
  const off = plan.disc > 0 ? ` · ${terms.pct}% ${PARTY_LABEL[party]} discount, ${inr(money(plan.disc))} off` : "";
  const message = payer
    ? `Bill ${no} · ₹${total}${off} posted to ${payer.name}`
    : `Bill ${no} · ₹${total}${off} ${input.tender === "Cash" ? "collected" : "settled by " + input.tender.toLowerCase()} at ${locName}`;
  // `receivables` only where the bill actually landed on somebody's account. Naming it on every
  // cash sale would put a report over every outlet's bills behind each one, for a balance that
  // cannot have moved; naming it on none would leave the manager's Credit screen reading
  // yesterday's figures while a counter bills against them.
  const changed: Changed[] = payer ? ["stock", "bills", "receivables"] : ["stock", "bills"];
  return { result, changed, message };
}
