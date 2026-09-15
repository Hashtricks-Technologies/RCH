// Adjustments: the flow - transaction, id, rules, ledger, history. Composes the helpers in
// apps/api/src/lib/; the arithmetic of a decision lives in packages/domain.
//
// **No document lock.** This write mints its own document and decides nothing about an existing
// one, so there is no row to take `for update` - the same shape `createPo` has, and the only
// reason that is safe there and here is that neither can afterwards wait on a document another
// writer is holding.
//
// **The id is taken last, after the balance locks rather than before them** - the second place
// in this server to invert the general documents → ids → balances order, after
// `modules/pos/service.ts`, and for that module's exact reason. See the comment on `allocateId`
// below before moving it: the short version is that `"adj"` has one allocator, so the cycle a
// lock order exists to prevent has no second party.
//
// **`stock_moves.reverses_id` stays null for every adjustment, `count` included.** A reversing
// move undoes one named move; a count corrects a *sum*, and the sum it corrects is every move
// ever posted to that shelf. There is no single move to point at, and pointing at the most
// recent one would read as "this undid that", which is not what a physical count found.
import type { z } from "zod";
import type { Adjustment, CreateAdjustmentBodySchema, WriteResponse } from "@rch/contract";
import { fq, REASON_LABEL, round3, unitTotal } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { allocateId } from "../../lib/ids.js";
import { lockBalances, postMoves, type Move } from "../../lib/ledger.js";
import { assertOpen, lockLocation } from "../../lib/locations.js";
import { loadMaster } from "../../lib/master.js";
import { reservedAt } from "../../lib/reservations.js";
import { assertRule } from "../../lib/rules.js";
import { iso } from "../../lib/time.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { adjustmentsRepo } from "./repo.js";

export type CreateAdjustmentBody = z.infer<typeof CreateAdjustmentBodySchema>;

// The word the trail is signed with is `REASON_LABEL` in @rch/domain, not a table here: the
// browser's picker and register print the same words, and a rule - or a wording - written twice
// is two things to keep in step.

export function createAdjustmentsService(db: Db) {
  return {
    /**
     * One correction to one shelf: some lines down, some up, one document over the lot.
     *
     * A write-off may not take more than is *free* - what a ticket is holding is somebody else's
     * promise, not this shelf's to destroy - and the cover check runs under the same balance
     * locks the moves are posted under, so two write-offs of the last unit cannot both pass.
     * A count-up on a line the location has never carried creates the balance row, which is the
     * operator saying the shelf carries it; that is the one place M12's "never lock a cell you
     * will not move" is satisfied by moving the cell rather than by leaving it alone.
     */
    async create(claims: AccessClaims, body: CreateAdjustmentBody): Promise<WriteResponse<Adjustment>> {
      return withTransaction(db, async (tx) => {
        // The shelf first - documents tier - and it decides the manager's scope: a manager adjusts
        // at an outlet and nowhere else. A 403, as it was when this was a list in routes.ts.
        const shelf = await lockLocation(tx, body.loc);
        if (claims.role === "manager" && shelf.type !== "Outlet") {
          throw new ForbiddenError("You can only adjust stock at an outlet - the central store writes off its own shelves");
        }
        if (shelf.type === "Outlet") assertOpen(shelf);

        const at = new Date();

        // One line per item before anything is checked: two lines naming the same item are two
        // halves of one correction, and checking them one at a time would let a −5 pass on a
        // shelf holding 3 because a +4 further down the form was going to cover it. What folds
        // to nothing is dropped rather than refused - a line typed and then undone is not a
        // mistake to explain, and a document with nothing left on it is.
        const folded = new Map<string, number>();
        for (const l of body.lines) folded.set(l.it, round3((folded.get(l.it) ?? 0) + l.qty));
        const lines = [...folded.entries()].map(([it, qty]) => ({ it, qty })).filter((l) => l.qty !== 0);
        assertRule(lines.length > 0, "Enter a quantity to write off or count up on at least one line");

        const master = await loadMaster(tx);
        for (const l of lines) if (!master.items[l.it]) throw new NotFoundError(`There is no item ${l.it}.`);
        const loc = body.loc;
        const locName = shelf.name;
        const unitOf = (it: string) => master.items[it]?.u ?? "nos";

        // Exactly the cells that move, and no others - `lockBalances` creates the row it locks,
        // so a speculative cell becomes a phantom "carried at zero" shelf line (M12). Every line
        // left after the fold moves, so every one of them is locked.
        await lockBalances(tx, lines.map((l) => ({ loc, it: l.it })));
        const keys = lines.map((l) => l.it);
        const onHand = await adjustmentsRepo.balancesAt(tx, loc, keys);
        const held = await reservedAt(tx, loc, keys);
        const freeOf = (it: string) => round3((onHand[it] ?? 0) - (held[`${loc}:${it}`] ?? 0));

        /** The store's own sentence for a shelf that will not cover a write-off - one helper for
         *  both the cover check below and the post-lock invariant further down, so the two can
         *  never drift into saying it two different ways. */
        const shortOf = (it: string, want: number, free: number): string => {
          const unit = unitOf(it);
          return `Cannot write off ${fq(want, unit)} ${unit} of ${master.items[it]?.n ?? it} - ${locName} has only ${fq(free, unit)} ${unit} free`;
        };

        const down = lines.filter((l) => l.qty < 0).map((l) => ({ it: l.it, qty: round3(-l.qty) }));
        const up = lines.filter((l) => l.qty > 0);
        // The first short line in the order the form was typed, which is the one the screen
        // names. Written as a find-then-refuse rather than a ternary inside `assertRule`, so a
        // refusal sentence is never computed on the success path.
        const short = down.find((l) => freeOf(l.it) < l.qty);
        if (short) assertRule(false, shortOf(short.it, short.qty, freeOf(short.it)));

        // The number, last - after the balance locks and after the cover check, rather than at
        // the head of the transaction. This is the inversion `modules/pos/service.ts` documents
        // and the exception `lib/ids.ts` describes: allocating locks the `sequences` row until
        // this transaction ends, so "a write that can still be refused, or that can still block
        // on something else, takes its number as late as it can".
        //
        // Safe here for pos's own reason, and only that one: `allocateId(tx, "adj"` has exactly
        // one caller - this line - so no second writer ever takes the `adj` sequence row before
        // a balance row and meets this one head on, and a deadlock needs two writers taking the
        // same two locks in opposite orders. `postMoves` below re-locks only cells this
        // transaction already holds, so it cannot wait on anything while holding this row.
        //
        // What taking it first cost was real and twofold: every adjustment in the hospital
        // queued on one row for the whole of somebody else's balance-lock wait, and the race
        // case below could not fail, because the second writer blocked on the sequence row
        // instead of on the shelf.
        const id = await allocateId(tx, "adj", at);

        const moves: Move[] = lines.map((l) => ({
          loc, it: l.it, qty: l.qty, kind: "adjustment", refType: "adjustment", refId: id, by: claims.sub, at,
        }));
        await postMoves(tx, moves);

        // The cover check above already ran under these locks, so this cannot fire today. It is
        // the invariant every negative-going move must keep, and it is what catches
        // the next caller that reads a balance before locking it.
        const after = await adjustmentsRepo.balancesAt(tx, loc, down.map((l) => l.it));
        const heldAfter = await reservedAt(tx, loc, down.map((l) => l.it));
        for (const l of down) {
          const left = round3((after[l.it] ?? 0) - (heldAfter[`${loc}:${l.it}`] ?? 0));
          assertRule(left >= 0, shortOf(l.it, l.qty, Math.max(0, round3(left + l.qty))));
        }

        const head = await adjustmentsRepo.insertHead(tx, {
          id, loc, reason: body.reason, note: body.note, byUser: claims.sub, at,
        });
        await adjustmentsRepo.insertLines(tx, lines.map((l, lineNo) => ({
          adjustmentId: id, lineNo, itemKey: l.it, qty: l.qty,
        })));
        const who = await adjustmentsRepo.userName(tx, claims.sub);
        // The trail carries the reason, not a status: an adjustment has no lifecycle to walk -
        // it happened once - so the one word worth recording is why the shelf changed.
        await appendHistory(tx, "adjustment", id, REASON_LABEL[body.reason], who, at);

        const result: Adjustment = {
          id: head.id, loc, reason: head.reason, note: head.note, by: who, at: iso(head.at), lines,
        };
        // Litres of milk and kilos of butter do not add up, so the toast groups by unit (M4).
        const message = down.length > 0 && up.length > 0
          ? `${id} - ${unitTotal(down, unitOf)} written off and ${unitTotal(up, unitOf)} counted up at ${locName}`
          : down.length > 0
            ? `${id} - ${unitTotal(down, unitOf)} written off at ${locName} (${REASON_LABEL[body.reason].toLowerCase()})`
            : `${id} - ${unitTotal(up, unitOf)} counted up at ${locName}`;

        const changed = ["stock", "adjustments"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message };
      });
    },
  };
}
