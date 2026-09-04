// Pos: the flow — transaction, rules, moves, id. Composes the helpers in apps/api/src/lib/;
// the arithmetic of the sale is `planBill` in packages/domain.
import type { z } from "zod";
import type { Bill, PayBodySchema, Tender, WriteResponse } from "@rch/contract";
import { avail, availOf, breachesCredit, creditBreachMessage, creditRoom, fq, planBill, round3, type Master } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { allocateId } from "../../lib/ids.js";
import { postMoves } from "../../lib/ledger.js";
import { loadMaster } from "../../lib/master.js";
import { reservedAt } from "../../lib/reservations.js";
import { assertRule } from "../../lib/rules.js";
import { monthStartIST } from "../../lib/time.js";
import { toWireBill } from "../../lib/wire.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { posRepo } from "./repo.js";

export type PayBody = z.infer<typeof PayBodySchema>;

/** A tender that is not money changing hands has to name whose account it lands on. Keyed by
 *  the closed set of tenders, so a new one added to `TenderSchema` has to be considered here. */
const NEEDS_PAYER: Partial<Record<Tender, string>> = { "Patient bill": "patient", "Staff credit": "staff member", Dept: "department" };

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
     * One counter sale, in one transaction: price it, refuse it if the shelf cannot cover it,
     * number it, write it, and post the moves. The friendly refusals read the balances before
     * the locks — so they can name the item and the number left — and `postMoves` then locks
     * every touched row; the re-read afterwards is the guarantee, because between the two a
     * second till may have sold the same last unit. A refusal there rolls the whole bill back.
     */
    async pay(claims: AccessClaims, body: PayBody): Promise<WriteResponse<Bill>> {
      return withTransaction(db, async (tx) => {
        const loc = body.loc;
        // A cart is a bag of scans: the same item read twice is one line of two, and the
        // cover check has to see the total, not each half.
        const cart: Record<string, number> = {};
        for (const l of body.lines) cart[l.it] = round3((cart[l.it] ?? 0) + l.qty);
        const keys = Object.keys(cart);
        assertRule(keys.length > 0, "Add at least one item to the bill");

        const need = NEEDS_PAYER[body.tender];
        assertRule(!(need && !body.payer), `Choose a ${need} before taking a ${body.tender.toLowerCase()}`);

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
        if (body.tender === "Staff credit" && body.payer) {
          const taken = await posRepo.staffCreditTaken(tx, body.payer.id, monthStartIST(at));
          assertRule(
            !breachesCredit(taken, plan.tot),
            creditBreachMessage(taken, plan.tot, body.payer.name),
            { taken, room: creditRoom(taken) },
          );
        }
        const no = await allocateId(tx, "bill", at);
        const head = await posRepo.insertBill(tx, {
          no, loc, operatorId: claims.sub, total: money(plan.tot), tax: money(plan.tax), at, tender: body.tender,
          payerKind: body.payer?.kind ?? null, payerId: body.payer?.id ?? null, payerName: body.payer?.name ?? null,
        });
        const lines = await posRepo.insertBillLines(tx, no, plan.lines);
        await postMoves(tx, plan.moves.map((m) => ({ ...m, kind: "sale" as const, refType: "bill", refId: no, by: claims.sub, at })));

        // What the sale actually took off each shelf, folded the way postMoves folded it. The
        // pre-check above spoke for the dish in portions; this one, keyed by what moved, names the
        // shelf item that went short — for a made-to-order dish that is the ingredient. Same
        // refusal, two voices: the first is friendlier, the second is the guarantee.
        //
        // Phase 3 puts holds on outlet shelves too — a shop transfer or a granted shop ask keeps
        // stock at a counter without moving it — so "short" now means on hand less what is held,
        // not merely negative. The hold is re-read here rather than reused from the pre-check
        // because every path that holds stock takes `lockBalances` first (see
        // apps/api/src/lib/ledger.ts): while this transaction holds those locks nothing new can
        // be held, so this read is the last word.
        const took = new Map<string, number>();
        for (const m of plan.moves) took.set(m.it, round3((took.get(m.it) ?? 0) + -m.qty));
        const moved = [...took.keys()];
        const onHand = await posRepo.onHandAt(tx, loc, moved);
        const heldNow = await reservedAt(tx, loc, moved);
        for (const [it, sold] of took) {
          const item = master.items[it];
          const unit = item?.u ?? "nos";
          const free = round3((onHand[it] ?? 0) - (heldNow[`${loc}:${it}`] ?? 0));
          const left = Math.max(0, round3(free + sold));
          assertRule(free >= 0, `Only ${fq(left, unit)} ${unit} of ${item?.n ?? it} left at ${locName}`);
        }

        const operator = await posRepo.operator(tx, claims.sub);
        const result = toWireBill(head, lines, { name: operator?.name ?? claims.sub, colour: operator?.colour ?? "#64748B" });
        const total = money(plan.tot).toFixed(2);
        const message = body.payer
          ? `Bill ${no} · ₹${total} posted to ${body.payer.name}`
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
