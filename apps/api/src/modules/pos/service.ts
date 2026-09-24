// Pos: the flow - transaction, rules, moves, id. Composes the helpers in apps/api/src/lib/;
// the arithmetic of the sale is `planBill` in packages/domain.
import type { z } from "zod";
import type { Bill, PayBodySchema, Tender, VoidBillBodySchema, WriteResponse } from "@rch/contract";
import { dmy, isAccountTender, istDate, money as inr, unitTotal } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { postMoves, type Move } from "../../lib/ledger.js";
import { assertOpen, lockLocation } from "../../lib/locations.js";
import { loadMaster } from "../../lib/master.js";
import { holdSession } from "../../lib/register.js";
import { assertRule } from "../../lib/rules.js";
import { postSale } from "../../lib/sale.js";
import { toWireBill } from "../../lib/wire.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { posRepo } from "./repo.js";

export type PayBody = z.infer<typeof PayBodySchema>;
export type VoidBillBody = z.infer<typeof VoidBillBodySchema>;

export function createPosService(db: Db) {
  return {
    /**
     * One counter sale, in one transaction. The sale itself is `postSale` (`lib/sale.ts`), which a
     * QR order's capture calls too, so a till bill and a QR bill can never be priced, covered or
     * numbered two different ways. What is the till's own is who rings it (the signed-in
     * operator, at the session's counter - `requireLoc` in routes.ts), that it takes a till
     * tender (`PayBodySchema`), and the announcement.
     */
    async pay(claims: AccessClaims, body: PayBody): Promise<WriteResponse<Bill>> {
      return withTransaction(db, async (tx) => {
        const out = await postSale(tx, {
          loc: body.loc, operatorId: claims.sub, lines: body.lines, tender: body.tender, payer: body.payer,
          customer: { name: body.customerName, phone: body.customerPhone }, source: "till",
        });
        // One array for the answer and the announcement, so the till that made the sale and the
        // tills watching it can never be told to refetch different slices.
        await emitChanged(tx, out.changed);
        return out;
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
        // Four eyes. Void a bill is grantable to any role that sees Bills, a counter's included, and
        // a till that could unsell its own takings is a till that could pocket them. The seeded
        // Outlet Manager never bills, so for the seeded roles this never fires.
        if (bill.operatorId === claims.sub) {
          throw new ForbiddenError("You can't void a bill you took yourself - ask someone else who holds Void a bill.");
        }

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

        // And the business day it belongs to has not been closed off yet. Same IST day is not
        // enough on its own: a counter can take the Z at 22:00 and a manager can reach for Void
        // at 22:05, still well inside the same day. A Z stores its figures as printed, precisely
        // so a reprint a week later says what the slip said, and a bill unsold after its Z would
        // leave those figures and the bills behind them disagreeing for good.
        //
        // The row is taken `FOR SHARE` before it is read, the same as a sale takes it: a close
        // running in the same instant then waits for this void and counts it, instead of
        // printing a Z this void is about to invalidate. A bill from before the register existed
        // carries no session and is judged by the same-day rule alone.
        const shut = bill.sessionId ? await holdSession(tx, bill.sessionId) : undefined;
        assertRule(!shut?.closedAt, `${no} was closed off on ${shut?.zNo} and can no longer be voided.`);

        // No `requireLocOf` here, on purpose: the void-a-bill action is hospital-wide (the seeded
        // Outlet Manager's `loc` is a desk, not a scope), and the route is already closed to
        // every role without it. Whoever took the bill is refused above, whatever they hold - it
        // is exactly the party that must not be able to unsell its own takings.
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
