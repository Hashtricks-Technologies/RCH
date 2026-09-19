// Pos: the flow - transaction, rules, moves, id. Composes the helpers in apps/api/src/lib/;
// the arithmetic of the sale is `planBill` in packages/domain.
import type { z } from "zod";
import type { Bill, PayBodySchema, Tender, VoidBillBodySchema, WriteResponse } from "@rch/contract";
import { avail, availOf, breachesCredit, creditBreachMessage, dmy, fq, isAccountTender, istDate, money as inr, partyOf, payerKindForTender, PARTY_LABEL, planBill, priceOf, round3, unitTotal, type Master } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { lockPayerCredit, outstandingFor } from "../../lib/credit.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { allocateId } from "../../lib/ids.js";
import { lockBalances, postMoves, type Move } from "../../lib/ledger.js";
import { assertOpen, lockLocation } from "../../lib/locations.js";
import { loadMaster } from "../../lib/master.js";
import { reservedAt } from "../../lib/reservations.js";
import { assertRule } from "../../lib/rules.js";
import { termsFor } from "../../lib/terms.js";
import { PAYER_LABEL, toWireBill } from "../../lib/wire.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { posRepo } from "./repo.js";

export type PayBody = z.infer<typeof PayBodySchema>;
export type VoidBillBody = z.infer<typeof VoidBillBodySchema>;

/** Money is stored and read at two decimals; `planBill` totals at full precision so the tax
 *  split is derived from the real amounts, not from a rounded one. */
const money = (n: number): number => Math.round(n * 100) / 100;

/** How many of `it` the location could sell right now: the free units of a stocked item. A
 *  made-to-order item holds no stock and moves none (`planBill`), so nothing caps it here -
 *  only its switch, which `availOf` reads. */
function coverOf(m: Master, stock: Record<string, Record<string, number>>, rsv: Record<string, number>, loc: string, it: string): number {
  if (m.items[it]?.t === "MTO") return Number.POSITIVE_INFINITY;
  return avail(stock, rsv, loc, it);
}

export function createPosService(db: Db) {
  return {
    /**
     * One counter sale, in one transaction: price it, lock the shelves it will move, refuse it
     * if they cannot cover it, number it, write it, and post the moves. The friendly refusals
     * read the balances before the locks - so they can name the item and the number left - and
     * the read under the locks is the guarantee, because between the two a second till may have
     * sold the same last unit. A refusal rolls the whole bill back.
     *
     * The number is taken last, after the balance locks rather than before them; the comment on
     * `allocateId` below says why that inversion is safe here and what it buys.
     */
    async pay(claims: AccessClaims, body: PayBody): Promise<WriteResponse<Bill>> {
      return withTransaction(db, async (tx) => {
        const loc = body.loc;
        // The outlet first - it is the documents tier - so a close waits for this sale to commit,
        // or this sale reads the outlet closed.
        assertOpen(await lockLocation(tx, loc));
        // A cart is a bag of scans: the same item read twice is one line of two, and the
        // cover check has to see the total, not each half.
        const cart: Record<string, number> = {};
        for (const l of body.lines) cart[l.it] = round3((cart[l.it] ?? 0) + l.qty);
        // `PayBodySchema.lines` is `.min(1)` with a positive `qty`, so a cart that folded to
        // nothing cannot reach here: there is no empty-cart rule to state a second time.
        const keys = Object.keys(cart);

        // A tender that is not money changing hands has to name whose account it lands on, and
        // the payer has to be of the kind the tender means (`payerKindForTender`, @rch/domain -
        // one table, because a tender that accepts the wrong kind of payer is a bill nothing
        // later counts: a staff credit posted to a consultant is invisible to the ceiling below
        // and to every receivables figure the manager reads).
        const needKind = payerKindForTender(body.tender);
        const needLabel = needKind ? PAYER_LABEL[needKind] : "";
        assertRule(!(needKind && !body.payer), `Choose a ${needLabel} before taking a ${body.tender.toLowerCase()}`);
        assertRule(!needKind || body.payer?.kind === needKind,
          `Choose a ${needLabel} for a ${body.tender.toLowerCase()} - ${body.payer?.name} is not one`);

        // And the payer has to be somebody the hospital already knows. The till sends a name
        // along with the id, but the name written on the bill is the roster's: a mistyped id is
        // a second account with its own untouched credit ceiling, and a name the counter typed
        // is a balance nobody can settle because nobody can find whose it is.
        const roster = body.payer ? await posRepo.payer(tx, body.payer.kind, body.payer.id) : undefined;
        if (body.payer) assertRule(roster, `There is no ${PAYER_LABEL[body.payer.kind]} ${body.payer.id} on the roster`);
        const payer = body.payer && roster ? { kind: body.payer.kind, id: body.payer.id, name: roster.name } : undefined;

        const master = await loadMaster(tx);
        const locName = master.locations[loc]?.n ?? loc;
        // A new outlet opens on no list at all (the manager attaches one from Prices), and
        // `priceOf` reads that as ₹0 rather than crashing. Refuse the whole cart here, before the
        // per-item loop and well before any lock or id, rather than let a ₹0 bill through while
        // still taking the stock off the shelf.
        assertRule(master.locations[loc]?.list, `Refused - ${locName} is on no price list; attach one from Prices before selling`);
        // One connection carries the transaction, so these queue behind each other anyway.
        const menu = await posRepo.menuAt(tx, loc);
        const stock = await posRepo.stockAt(tx, loc);
        const rsv = await posRepo.rsvAt(tx, loc);
        const ovr = await posRepo.ovrAt(tx, loc);
        const prices = await posRepo.prices(tx);

        for (const it of keys) {
          const item = master.items[it];
          if (!item) throw new NotFoundError(`There is no item ${it}.`);
          assertRule(menu.has(it), `${item.n} is not listed at ${locName}`);
          const a = availOf(master, stock, rsv, ovr, loc, it);
          assertRule(a.ok, `${item.n} is not available at ${locName} - ${a.why}`);
          const cover = coverOf(master, stock, rsv, loc, it);
          assertRule(cover >= cart[it], `Only ${fq(cover, item.u)} ${item.u} of ${item.n} left at ${locName}`);
          // The outlet has a list (checked above); this item may still be missing from it - a
          // product listed at the counter before the manager ever priced it there.
          assertRule(priceOf(master, prices, loc, it).p > 0, `Refused - ${item.n} has no price at ${locName}`);
        }

        // What this party is charged. Read inside the transaction, so the bill is priced against
        // the rate card this transaction commits against - a manager changing the doctors' rate
        // in the same instant either lands before this sale or after it, never half way through
        // it. The till previews the same number off the snapshot; the server decides it.
        const party = partyOf(payer);
        const terms = await termsFor(tx, party, payer);
        const plan = planBill(master, prices, loc, cart, terms.pct);
        const at = new Date();
        // A tender that takes no money now runs up a balance somebody settles later. The ceiling
        // is on what is still **unsettled**, not on a calendar month: somebody who cleared their
        // account yesterday has their room back today. Checked here rather than only on the
        // counter's screen - a second tab or a stale page would otherwise walk straight past a
        // disabled button.
        if (payer) {
          // Read the balance under a lock on the person, not merely read it: two tills selling
          // to one person in the same instant would otherwise both see the room that existed
          // before either wrote, and both fit under a ceiling only one of them fits under.
          await lockPayerCredit(tx, payer.kind, payer.id);
          // One query, three callers: this refusal, `GET /reports/credit/:kind/:id` and the
          // manager's receivables list (apps/api/src/lib/credit.ts).
          const { outstanding } = await outstandingFor(tx, payer.kind, payer.id);
          assertRule(
            !breachesCredit(outstanding, plan.tot, terms.limit),
            // Only reached when there is a limit, which is what `breachesCredit` answers `false`
            // for when there is not - so the non-null assertion here is the same condition.
            creditBreachMessage(outstanding, plan.tot, payer.name, terms.limit ?? 0),
            { outstanding, limit: terms.limit },
          );
        }
        // What the sale will take off each shelf, folded the way postMoves folds it. A
        // made-to-order line moves nothing, so a bill of nothing else locks and reads no shelf.
        // Same refusal as the pre-check above: that one is friendlier, this one is the guarantee.
        //
        // Phase 3 puts holds on outlet shelves too - a shop transfer or a granted shop ask keeps
        // stock at a counter without moving it - so "short" means on hand less what is held, not
        // merely negative. Both numbers are read again here rather than reused from the
        // pre-check, and read *after* `lockBalances`: every path that holds stock takes those
        // same locks first (see apps/api/src/lib/ledger.ts), so while this transaction holds
        // them nothing new can be sold or held on these shelves and this read is the last word.
        const took = new Map<string, number>();
        for (const m of plan.moves) took.set(m.it, round3((took.get(m.it) ?? 0) + -m.qty));
        const moved = [...took.keys()];
        await lockBalances(tx, moved.map((it) => ({ loc, it })));
        const onHand = await posRepo.onHandAt(tx, loc, moved);
        const heldNow = await reservedAt(tx, loc, moved);
        for (const [it, sold] of took) {
          const item = master.items[it];
          const unit = item?.u ?? "nos";
          const free = round3((onHand[it] ?? 0) - (heldNow[`${loc}:${it}`] ?? 0));
          assertRule(free >= sold, `Only ${fq(Math.max(0, free), unit)} ${unit} of ${item?.n ?? it} left at ${locName}`);
        }

        // The number, last - deliberately after the balance locks rather than before them, which
        // is the one place in this server where an id is not taken ahead of a shelf.
        //
        // `allocateId(tx, "bill"` has exactly one caller, this line, so no second writer can ever
        // take the `bill` sequence row before a balance row and meet this one head on: the cycle
        // a lock order exists to prevent needs two writers taking the same two locks in opposite
        // orders, and there is no other writer of this row at all. What taking it earlier did
        // cost was real - a till queued behind a shelf sat on the one row every till in the
        // hospital draws its bill number from, so one slow sale at one counter froze the rest.
        // Keep this line where it is, and keep it the last thing before the bill is written.
        const no = await allocateId(tx, "bill", at);
        const head = await posRepo.insertBill(tx, {
          no, loc, operatorId: claims.sub, total: money(plan.tot), tax: money(plan.tax), at, tender: body.tender,
          payerKind: payer?.kind ?? null, payerId: payer?.id ?? null, payerName: payer?.name ?? null,
          // The rate as well as the rupees: the rate card moves, and a bill has to be able to say
          // what it was charged at long after somebody changed it.
          discountPct: terms.pct, discount: money(plan.disc),
        });
        const lines = await posRepo.insertBillLines(tx, no, plan.lines);
        await postMoves(tx, plan.moves.map((m) => ({ ...m, kind: "sale" as const, refType: "bill", refId: no, by: claims.sub, at })));

        // And once more with the moves actually posted. It can never fire today - the cover
        // check above ran under these same locks and nothing can have written behind it - and it
        // is kept because every negative-going move re-reads what it moved, and this is what
        // would catch the next caller that reads a balance before it locks it.
        const settled = await posRepo.onHandAt(tx, loc, moved);
        const stillHeld = await reservedAt(tx, loc, moved);
        for (const [it, sold] of took) {
          const item = master.items[it];
          const unit = item?.u ?? "nos";
          const free = round3((settled[it] ?? 0) - (stillHeld[`${loc}:${it}`] ?? 0));
          assertRule(free >= 0, `Only ${fq(Math.max(0, round3(free + sold)), unit)} ${unit} of ${item?.n ?? it} left at ${locName}`);
        }

        const operator = await posRepo.operator(tx, claims.sub);
        const result = toWireBill(head, lines, { name: operator?.name ?? claims.sub, colour: operator?.colour ?? "#64748B" });
        const total = money(plan.tot).toFixed(2);
        // The concession is named where there was one, and named as the rate rather than only the
        // rupees: "20% off" is the thing the operator has to be able to check at a glance against
        // what the person in front of them expected.
        const off = plan.disc > 0 ? ` · ${terms.pct}% ${PARTY_LABEL[party]} discount, ${inr(money(plan.disc))} off` : "";
        const message = payer
          ? `Bill ${no} · ₹${total}${off} posted to ${payer.name}`
          : `Bill ${no} · ₹${total}${off} ${body.tender === "Cash" ? "collected" : "settled by " + body.tender.toLowerCase()} at ${locName}`;
        // One array for the answer and the announcement, so the till that made the sale and
        // the tills watching it can never be told to refetch different slices.
        //
        // `receivables` only where the bill actually landed on somebody's account. Naming it on
        // every cash sale would put a report over every outlet's bills behind each one, for a
        // balance that cannot have moved; naming it on none would leave the manager's Credit
        // screen reading yesterday's figures while a counter bills against them.
        const changed = payer ? ["stock", "bills", "receivables"] as const : ["stock", "bills"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message };
      });
    },

    /**
     * Take a mis-keyed bill back, on the day it was taken and no later.
     *
     * The honest minimum, and deliberately no more: the bill stays on the table exactly as it
     * was printed, one positive reversal per line of the sale puts the stock back where it came
     * off, and the two sums that count money - the staff-credit ceiling and the dashboard's
     * takings - learn to skip it. A credit note for a bill from yesterday is a different
     * document with different paperwork, and it stays refused until somebody asks for it; the
     * refusal says so, and names the adjustment as the door that is open.
     */
    async voidBill(claims: AccessClaims, no: string, body: VoidBillBody): Promise<WriteResponse<Bill>> {
      return withTransaction(db, async (tx) => {
        // The document first, locked - the order every write in this server keeps. Two managers
        // pressing Void on the same bill queue here, and the second reads what the first wrote.
        const bill = await posRepo.headForUpdate(tx, no);
        if (!bill) throw new NotFoundError(`There is no bill ${no}.`);

        const reason = body.reason.trim();
        assertRule(reason.length > 0, "Give a reason for voiding this bill");
        assertRule(!bill.voidedAt, `${no} has already been voided`);

        // Same hospital day, in the hospital's own zone - a till that closed at 23:50 must still
        // be able to fix its last bill, and a manager arriving at 09:00 must not be able to
        // unpick yesterday's takings after the day was reconciled.
        const at = new Date();
        assertRule(istDate(bill.at) === istDate(at),
          `${no} was taken on ${dmy(istDate(bill.at))} - a bill can only be voided on the day it was billed; write the stock back on with an adjustment instead`);

        // And nobody has paid it off yet. A void erases the debt the bill created, so voiding one
        // a settlement has already closed would leave the payment sitting against nothing and the
        // payer's balance short by exactly this bill. Rare - a void is same-day and a settlement
        // is usually a month later - but the two can meet on the last day of a month, which is
        // precisely when somebody is settling. The settlement is the document to take back first,
        // and the refusal names it.
        const paid = await posRepo.liveSettlementOf(tx, no);
        assertRule(!paid, `${no} has been settled by ${paid?.id} - void that settlement first, then this bill`);

        // A void posts the sale's stock back onto the shelf it came off, and a closed outlet's shelves
        // were emptied to close it.
        assertOpen(await lockLocation(tx, bill.loc), "reopen it before voiding its bills");

        // No `requireLocOf` here, on purpose: a manager is hospital-wide (their `loc` is a desk,
        // not a scope), and the route is already closed to every other role. The counter that
        // took the bill is exactly the party that must not be able to unsell its own takings.
        //
        // And no `allocateId`: a void mints no document. It is a stamp on the bill that exists
        // and a reversal of the moves that exist, so there is no number for it to draw.
        const moves = await posRepo.saleMoves(tx, no);
        const master = await loadMaster(tx);
        const locName = master.locations[bill.loc]?.n ?? bill.loc;
        // Each reversal uses its original move's own `loc` and item rather than the bill's lines,
        // so what goes back is exactly what the sale took. A made-to-order line took nothing, and
        // a bill with nothing else on it - or whose lines all rounded away - posts nothing and
        // still voids.
        const reversals: Move[] = moves.map((m) => ({
          loc: m.loc, it: m.itemKey, qty: -m.qty, kind: "reversal" as const,
          refType: "bill", refId: no, by: claims.sub, at, reverses: m.id,
        }));
        await postMoves(tx, reversals);
        // No `lockBalances` of its own and no post-lock re-read: every reversal is positive -
        // it is a sale's negative move, negated - so there is nothing promised against a balance
        // for the belt-and-braces check to catch. Same reasoning as a goods receipt's two
        // positive moves (`modules/grn/service.ts`); do not add either out of symmetry with the
        // sale above.

        const head = await posRepo.setVoided(tx, no, { at, by: claims.sub, reason });
        const lines = await posRepo.billLines(tx, no);
        const voider = await posRepo.operator(tx, claims.sub);
        // The first row of history a bill has ever carried. It is not on the wire - `BillSchema`
        // has no `hist` - because there is exactly one thing that can be said about a bill after
        // it is printed, and the badge and the reason already say it.
        await appendHistory(tx, "bill", no, `Voided - ${reason}`, voider?.name ?? claims.sub, at);

        const operator = await posRepo.operator(tx, head.operatorId);
        const result = toWireBill(head, lines, { name: operator?.name ?? head.operatorId, colour: operator?.colour ?? "#64748B" });
        const back = reversals.map((r) => ({ it: r.it, qty: r.qty }));
        const unitOf = (it: string) => master.items[it]?.u ?? "nos";
        // What the manager most needs told is what the void gave back. For a bill on somebody's
        // account that is the room it frees, which is the thing a mis-keyed bill actually costs
        // them; otherwise it is the stock that went back on the shelf.
        const message = head.payerKind && isAccountTender(head.tender as Tender)
          ? `${no} voided - ${inr(head.total)} is off ${head.payerName ?? head.payerId}'s account`
          : back.length > 0
            ? `${no} voided - ${unitTotal(back, unitOf)} back on the shelf at ${locName}`
            : `${no} voided`;
        // Same rule as the sale: a void takes the debt back off the account it was posted to.
        const changed = head.payerKind ? ["stock", "bills", "receivables"] as const : ["stock", "bills"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message };
      });
    },
  };
}
