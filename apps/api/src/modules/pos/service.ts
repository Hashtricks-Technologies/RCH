// Pos: the flow — transaction, rules, moves, id. Composes the helpers in apps/api/src/lib/;
// the arithmetic of the sale is `planBill` in packages/domain.
import type { z } from "zod";
import type { Bill, PayBodySchema, PayerKind, Tender, WriteResponse } from "@rch/contract";
import { avail, availOf, breachesCredit, creditBreachMessage, creditRoom, fq, planBill, round3, type Master } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { creditTakenThisMonth } from "../../lib/credit.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { allocateId } from "../../lib/ids.js";
import { lockBalances, postMoves } from "../../lib/ledger.js";
import { loadMaster } from "../../lib/master.js";
import { reservedAt } from "../../lib/reservations.js";
import { assertRule } from "../../lib/rules.js";
import { toWireBill } from "../../lib/wire.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { posRepo } from "./repo.js";

export type PayBody = z.infer<typeof PayBodySchema>;

/** What the operator calls each kind of payer. One list, so the sentence that asks for a payer
 *  and the sentence that says the roster has never heard of one use the same word. */
const PAYER_LABEL: Record<PayerKind, string> = { patient: "patient", staff: "staff member", dept: "department" };

/** A tender that is not money changing hands has to name whose account it lands on: the word
 *  the operator reads, and the kind of payer that word means. One table for both, because a
 *  tender that accepts the wrong kind of payer is a bill nothing later counts — a staff credit
 *  posted to a patient is invisible to the ceiling below. Keyed by the closed set of tenders,
 *  so a new one added to `TenderSchema` has to be considered here. */
const NEEDS_PAYER: Partial<Record<Tender, { label: string; kind: PayerKind }>> = {
  "Patient bill": { label: PAYER_LABEL.patient, kind: "patient" },
  "Staff credit": { label: PAYER_LABEL.staff, kind: "staff" },
  Dept: { label: PAYER_LABEL.dept, kind: "dept" },
};

/** Money is stored and read at two decimals; `planBill` totals at full precision so the tax
 *  split is derived from the real amounts, not from a rounded one. */
const money = (n: number): number => Math.round(n * 100) / 100;

/** How many of `it` the location could sell right now: units for a traded item, whole
 *  portions for a made-to-order one, whichever ingredient runs out first. */
function coverOf(m: Master, stock: Record<string, Record<string, number>>, rsv: Record<string, number>, loc: string, it: string): number {
  const recipe = m.items[it]?.t === "MTO" ? m.recipes[it] : undefined;
  if (!recipe) return avail(stock, rsv, loc, it);
  return Math.min(...recipe.l.map(([g, need]) => Math.floor(avail(stock, rsv, loc, g) / need)));
}

export function createPosService(db: Db) {
  return {
    /**
     * One counter sale, in one transaction: price it, lock the shelves it will move, refuse it
     * if they cannot cover it, number it, write it, and post the moves. The friendly refusals
     * read the balances before the locks — so they can name the item and the number left — and
     * the read under the locks is the guarantee, because between the two a second till may have
     * sold the same last unit. A refusal rolls the whole bill back.
     *
     * The number is taken last, after the balance locks rather than before them; the comment on
     * `allocateId` below says why that inversion is safe here and what it buys.
     */
    async pay(claims: AccessClaims, body: PayBody): Promise<WriteResponse<Bill>> {
      return withTransaction(db, async (tx) => {
        const loc = body.loc;
        // A cart is a bag of scans: the same item read twice is one line of two, and the
        // cover check has to see the total, not each half.
        const cart: Record<string, number> = {};
        for (const l of body.lines) cart[l.it] = round3((cart[l.it] ?? 0) + l.qty);
        // `PayBodySchema.lines` is `.min(1)` with a positive `qty`, so a cart that folded to
        // nothing cannot reach here: there is no empty-cart rule to state a second time.
        const keys = Object.keys(cart);

        const need = NEEDS_PAYER[body.tender];
        assertRule(!(need && !body.payer), `Choose a ${need?.label} before taking a ${body.tender.toLowerCase()}`);
        // And the payer has to be of the kind the tender means. Without this the two halves
        // disagree — the ceiling below counts staff payers, so a staff credit posted to a
        // patient would run up a balance no rule ever measures.
        assertRule(!need || body.payer?.kind === need.kind,
          `Choose a ${need?.label} for a ${body.tender.toLowerCase()} — ${body.payer?.name} is not one`);

        // And the payer has to be somebody the hospital already knows. The till sends a name
        // along with the id, but the name written on the bill is the roster's: a mistyped id is
        // a second account with its own untouched credit ceiling, and a name the counter typed
        // is a balance nobody can settle because nobody can find whose it is.
        const roster = body.payer ? await posRepo.payer(tx, body.payer.kind, body.payer.id) : undefined;
        if (body.payer) assertRule(roster, `There is no ${PAYER_LABEL[body.payer.kind]} ${body.payer.id} on the roster`);
        const payer = body.payer && roster ? { kind: body.payer.kind, id: body.payer.id, name: roster.name } : undefined;

        const master = await loadMaster(tx);
        const locName = master.locations[loc]?.n ?? loc;
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
          assertRule(a.ok, `${item.n} is not available at ${locName} — ${a.why}`);
          const cover = coverOf(master, stock, rsv, loc, it);
          assertRule(cover >= cart[it], `Only ${fq(cover, item.u)} ${item.u} of ${item.n} left at ${locName}`);
        }

        const plan = planBill(master, prices, loc, cart);
        const at = new Date();
        // A tender that takes no money now runs up a balance somebody settles later. The ceiling
        // is the person's, over the calendar month the hospital settles on, and it is checked
        // here rather than only on the counter's screen — a second tab or a stale page would
        // otherwise walk straight past a disabled button.
        if (body.tender === "Staff credit" && payer) {
          // Read the total under a lock on the person, not merely read it: two tills selling to
          // one staff member in the same instant would otherwise both see the room that existed
          // before either wrote, and both fit under a ceiling only one of them fits under.
          await posRepo.lockStaffCredit(tx, payer.id);
          // One query, two callers: this refusal and `GET /reports/credit/:kind/:id`
          // (apps/api/src/lib/credit.ts). The sale still stamps the window from its own `at`,
          // the same instant the bill is written with, so a sale at 00:00:00 on the first is
          // measured against the month it lands in.
          const { taken } = await creditTakenThisMonth(tx, "staff", payer.id, at);
          assertRule(
            !breachesCredit(taken, plan.tot),
            creditBreachMessage(taken, plan.tot, payer.name),
            { taken, room: creditRoom(taken) },
          );
        }
        // What the sale will take off each shelf, folded the way postMoves folds it. The
        // pre-check above spoke for the dish in portions; this one, keyed by what moves, names
        // the shelf item that goes short — for a made-to-order dish that is the ingredient.
        // Same refusal, two voices: the first is friendlier, this one is the guarantee.
        //
        // Phase 3 puts holds on outlet shelves too — a shop transfer or a granted shop ask keeps
        // stock at a counter without moving it — so "short" means on hand less what is held, not
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

        // The number, last — deliberately after the balance locks rather than before them, which
        // is the one place in this server where an id is not taken ahead of a shelf.
        //
        // `allocateId(tx, "bill"` has exactly one caller, this line, so no second writer can ever
        // take the `bill` sequence row before a balance row and meet this one head on: the cycle
        // a lock order exists to prevent needs two writers taking the same two locks in opposite
        // orders, and there is no other writer of this row at all. What taking it earlier did
        // cost was real — a till queued behind a shelf sat on the one row every till in the
        // hospital draws its bill number from, so one slow sale at one counter froze the rest.
        // Keep this line where it is, and keep it the last thing before the bill is written.
        const no = await allocateId(tx, "bill", at);
        const head = await posRepo.insertBill(tx, {
          no, loc, operatorId: claims.sub, total: money(plan.tot), tax: money(plan.tax), at, tender: body.tender,
          payerKind: payer?.kind ?? null, payerId: payer?.id ?? null, payerName: payer?.name ?? null,
        });
        const lines = await posRepo.insertBillLines(tx, no, plan.lines);
        await postMoves(tx, plan.moves.map((m) => ({ ...m, kind: "sale" as const, refType: "bill", refId: no, by: claims.sub, at })));

        // And once more with the moves actually posted. It can never fire today — the cover
        // check above ran under these same locks and nothing can have written behind it — and it
        // is kept for the reason `makeBatch` keeps its own: spec §12 asks every negative-going
        // move to re-read what it moved, and this is what would catch the next caller that reads
        // a balance before it locks it.
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
        const message = payer
          ? `Bill ${no} · ₹${total} posted to ${payer.name}`
          : `Bill ${no} · ₹${total} ${body.tender === "Cash" ? "collected" : "settled by " + body.tender.toLowerCase()} at ${locName}`;
        // One array for the answer and the announcement, so the till that made the sale and
        // the tills watching it can never be told to refetch different slices.
        const changed = ["stock", "bills"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message };
      });
    },
  };
}
