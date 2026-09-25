// Tickets: the movement rule in code. Approval authorises and the scan moves - so a handover
// is the one place stock leaves a location on this path, a receipt the one place it lands, and
// between the two it is in transit and owned by neither.
import { timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import type { CancelTicketBodySchema, Changed, HandoverBodySchema, Ticket, TransferBodySchema, WriteResponse } from "@rch/contract";
import { approvedStatus, canTransition, fq, PROD_ORDER_TRANSITIONS, REQUEST_TRANSITIONS, round3, SHOP_ASK_TRANSITIONS, TICKET_TRANSITIONS } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction, type Tx } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { lockBalances, postMoves, withUseOnArrival } from "../../lib/ledger.js";
import { assertOpen, lockLocation } from "../../lib/locations.js";
import { loadItems, loadItemTypes, loadLocations } from "../../lib/master.js";
import { releaseForTicket, reservedAt } from "../../lib/reservations.js";
import { assertRule, assertTransition } from "../../lib/rules.js";
import { allocateTicket, readTicket, voidTicket, writeTicket } from "../../lib/tickets.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { requireLocOf } from "../../plugins/rbac.js";
import { ticketsRepo } from "./repo.js";

export type HandoverBody = z.infer<typeof HandoverBodySchema>;
export type TransferBody = z.infer<typeof TransferBodySchema>;
export type CancelTicketBody = z.infer<typeof CancelTicketBodySchema>;

/** The ticket as it now stands. The row is locked and was just written, so this cannot miss;
 *  the guard is here because `readTicket` answers for any id, including one that never was. */
async function reread(tx: Tx, id: string): Promise<Ticket> {
  const t = await readTicket(tx, id);
  if (!t) throw new NotFoundError(`There is no ticket ${id}.`);
  return t;
}

/**
 * How many wrong codes a ticket will take before the window stops listening. Six digits is a
 * million guesses on paper and about a dozen an hour in practice at a hatch - but nothing stops
 * a script, and a ticket that can be guessed at for ever is a shelf that can be emptied by
 * anyone who can reach the endpoint. Five is what a collector who has genuinely misread the slip
 * needs, and far less than a search needs.
 */
const OTP_ATTEMPTS = 5;

/** What is read to the collector when the guessing has to stop. There is one way past it now
 *  that the supervisor override is gone: withdraw the ticket and issue a new one, with new
 *  digits. The sentence says so plainly rather than leaving the operator to find that out. */
const lockedMessage = (id: string) =>
  `${id} is locked after five wrong codes - cancel it and issue a new one, with fresh digits`;

/**
 * The typed code against the row's own, in constant time. `===` on a secret leaks how much of it
 * is right through how long the comparison took, which over enough tries is the code - and the
 * attempt limit above is exactly what makes "enough tries" the thing to worry about.
 *
 * `timingSafeEqual` throws on buffers of unequal length, so the lengths are checked first:
 * `HandoverBodySchema` already holds the typed code to six digits and the column holds six, so
 * anything else is simply a wrong code and there is nothing to leak about it.
 */
function otpMatches(typed: string, real: string): boolean {
  const a = Buffer.from(typed, "utf8");
  const b = Buffer.from(real, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createTicketsService(db: Db) {
  return {
    /**
     * The scan at the window. One transaction: the OTP (or the labelled override), the
     * `ticket_out` moves at the sending location, the release of the hold those moves replace,
     * and the request behind the ticket moved on. A refusal anywhere rolls all of it back, so
     * a wrong OTP moves nothing.
     *
     * One thing has to survive that rollback, which is why this is the only write in the server
     * that does not simply `return withTransaction(...)`: a wrong code is **counted**, and a
     * count thrown away with the refusal that caused it would let a caller guess for ever. So
     * the transaction commits the increment and hands back the sentence, and the refusal is
     * raised out here, after the commit. Nothing else has been written by then - the OTP is
     * checked before the first move - so the committed transaction carries the count and only
     * the count.
     *
     * `{ response: "optional" }` is what lets that stand. The idempotency record is written
     * inside this transaction as its last statement (`lib/db.ts`), and the `{ refuse }` marker
     * is not a shape the route's response schema will take - so without it the marker would be
     * read as a broken response and roll the count back, answering 500 where the collector
     * should have read a refusal. `"optional"` says what is true here: this transaction is not
     * producing the write's answer, the caller is about to throw it, and `onSend` records the
     * 4xx the way it does for every other refusal. The success path below returns the real
     * response and is recorded exactly as before.
     */
    async handover(claims: AccessClaims, id: string, body: HandoverBody): Promise<WriteResponse<Ticket>> {
      const done = await withTransaction<WriteResponse<Ticket> | { refuse: string }>(db, async (tx) => {
        const t = await ticketsRepo.head(tx, id);
        if (!t) throw new NotFoundError(`There is no ticket ${id}.`);
        // Documents locked before ids, ids before balances (lib/ledger.ts's header): this
        // ticket's own row is locked above, and the request behind it - the only other document
        // this write touches - right here, both ahead of the balance locks `postMoves` takes.
        const linked = await ticketsRepo.linkedRequest(tx, t.req);
        requireLocOf(claims, t.from, "the location the ticket is issued from");
        assertTransition(TICKET_TRANSITIONS, t.st, "Collected", id);

        // The OTP is quoted by the collector and typed at the window, and it is now the only way
        // stock leaves on a ticket. There used to be a labelled supervisor override here - an
        // OTP-less handover open to the store and the kitchen - and it is gone: the code the
        // collecting side reads out is the whole of the authorisation.
        //
        // Five wrong codes and the ticket is shut. Nothing reopens it; it is cancelled and
        // reissued with fresh digits, which is what `lockedMessage` tells the operator to do.
        assertRule(t.otpAttempts < OTP_ATTEMPTS, lockedMessage(id));
        if (!otpMatches(body.otp, t.otp)) {
          // The one write this transaction is allowed to commit on the way to a refusal.
          await ticketsRepo.countWrongOtp(tx, id);
          return { refuse: `That OTP does not match ${id}. Ask the collector to read it again.` };
        }

        const at = new Date();
        const items = await loadItems(tx);
        const locations = await loadLocations(tx);
        const fromName = locations[t.from]?.n ?? t.from;
        const toName = locations[t.to]?.n ?? t.to;

        // The scan moves: the stock leaves `from` here and belongs to nobody until it is received.
        await postMoves(tx, t.lines.map((l) => ({ loc: t.from, it: l.it, qty: -l.qty, kind: "ticket_out" as const, refType: "ticket", refId: id, by: claims.sub, at })));
        // postMoves holds the locks; this read is the guarantee. The cover check at issue time
        // was the courtesy, and a sale on the same shelf may have happened since.
        const after = await ticketsRepo.balancesAt(tx, t.from, t.lines.map((l) => l.it));
        for (const l of t.lines) {
          const item = items[l.it];
          const unit = item?.u ?? "nos";
          assertRule((after[l.it] ?? 0) >= 0, `${toName} cannot collect ${fq(l.qty, unit)} ${unit} of ${item?.n ?? l.it} - ${fromName} no longer has it`);
        }
        // The hold has done its work and the moves have taken its place.
        await releaseForTicket(tx, id, at);
        await ticketsRepo.setStatus(tx, id, { status: "Collected", collectedAt: at });

        const who = await ticketsRepo.userName(tx, claims.sub);
        // One row, one act: the trail is read as a sequence, and a second row for the same
        // handover would read as a second handover.
        await appendHistory(tx, "ticket", id, "Handed over", who, at);
        if (linked && canTransition(REQUEST_TRANSITIONS, linked.status, "Collected")) {
          await ticketsRepo.setRequestStatus(tx, linked.id, "Collected");
          await appendHistory(tx, "request", linked.id, "Collected", who, at);
        }

        // One array for the answer and the announcement, so the window that handed the stock
        // over and the screens watching it are never told to refetch different slices.
        const changed = ["tkt", "req", "rsv", "stock"] as const;
        await emitChanged(tx, changed);
        return {
          result: await reread(tx, id),
          changed: [...changed],
          message: `${id} handed over - stock is in transit to ${toName}`,
        };
      }, { response: "optional" });
      // The wrong code is on the row now, committed; this is the sentence that goes with it.
      if ("refuse" in done) assertRule(false, done.refuse);
      return done;
    },

    /** The scan on the shelf: the mirror of handover, and the end of the request behind it. */
    async receive(claims: AccessClaims, id: string): Promise<WriteResponse<Ticket>> {
      return withTransaction(db, async (tx) => {
        const t = await ticketsRepo.head(tx, id);
        if (!t) throw new NotFoundError(`There is no ticket ${id}.`);
        // Documents locked before ids, ids before balances (lib/ledger.ts's header): this
        // ticket's own row is locked above, and the request behind it - the only other document
        // this write touches - right here, both ahead of the balance locks `postMoves` takes.
        // Taken after the moves it would invert that order against every other writer, and a
        // receipt racing something that holds the request first would deadlock instead of queue.
        const linked = await ticketsRepo.linkedRequest(tx, t.req);
        requireLocOf(claims, t.to, "the location the ticket is coming to");
        assertTransition(TICKET_TRANSITIONS, t.st, "Received", id);

        const at = new Date();
        const locations = await loadLocations(tx);
        const toName = locations[t.to]?.n ?? t.to;
        // Booking stock in cannot drive a balance below zero, so this is the one movement with
        // no post-lock re-read behind it - the only asymmetry between the two ends of a ticket.
        // Raw materials and packaging landing at the kitchen are used as they land: each gets its
        // `production_consume` beside its `ticket_in`, in the same call (`withUseOnArrival`).
        const types = await loadItemTypes(tx);
        const landed = t.lines.map((l) => ({ loc: t.to, it: l.it, qty: l.qty, kind: "ticket_in" as const, refType: "ticket", refId: id, by: claims.sub, at }));
        const moves = withUseOnArrival(types, landed);
        await postMoves(tx, moves);
        const used = moves.length > landed.length;
        await ticketsRepo.setStatus(tx, id, { status: "Received", receivedAt: at });

        const who = await ticketsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "ticket", id, "Received", who, at);
        // The request closes here, and the word printed on its trail is the ticket's own
        // "Received" - the word the operator reads at the shelf, kept verbatim from the store.
        if (linked && canTransition(REQUEST_TRANSITIONS, linked.status, "Closed")) {
          await ticketsRepo.setRequestStatus(tx, linked.id, "Closed");
          await appendHistory(tx, "request", linked.id, "Received", who, at);
        }

        const changed = ["tkt", "req", "stock"] as const;
        await emitChanged(tx, changed);
        return {
          result: await reread(tx, id), changed: [...changed],
          message: used ? `Received at ${toName} - issued to the kitchen for use` : `Received at ${toName} - stock is on the shelf`,
        };
      });
    },

    /**
     * A ticket withdrawn before anyone collected against it.
     *
     * Phase 3 gave `releaseForTicket` one caller - the handover - so a ticket nobody came for
     * held its stock for ever: free-to-promise stayed smaller than the shelf and the request
     * behind it had nowhere to go. This is the way back. Nothing moves, because nothing had
     * moved; what changes is that the promise is withdrawn and the document behind the ticket
     * goes back to where it was before the ticket was raised.
     *
     * No balance locks: a release only ever makes free-to-promise larger, so a writer racing it
     * is right either way. What must not race is two cancellations of one ticket, and the
     * ticket's own `for update` above is what stops that.
     */
    async cancel(claims: AccessClaims, id: string, body: CancelTicketBody): Promise<WriteResponse<Ticket>> {
      return withTransaction(db, async (tx) => {
        const t = await ticketsRepo.head(tx, id);
        if (!t) throw new NotFoundError(`There is no ticket ${id}.`);
        requireLocOf(claims, t.from, "the location the ticket is issued from");
        const reason = body.reason.trim();
        assertRule(reason.length > 0, "Say why the ticket is being cancelled");

        const locations = await loadLocations(tx);
        const fromName = locations[t.from]?.n ?? t.from;
        const toName = locations[t.to]?.n ?? t.to;
        assertRule(
          canTransition(TICKET_TRANSITIONS, t.st, "Cancelled"),
          t.st === "Cancelled"
            ? `${id} is already cancelled`
            : `${id} has already been handed over - the stock is on its way to ${toName}`,
        );

        // Documents before ids before balances, and this write needs no id and no balance: the
        // ticket's row is locked above and the document behind it right here.
        const at = new Date();
        const request = t.refType === "request" ? await ticketsRepo.linkedRequest(tx, t.req) : undefined;
        const order = t.refType === "prod_order" ? await ticketsRepo.linkedProdOrder(tx, t.req) : undefined;
        const ask = t.refType === "shop_ask" ? await ticketsRepo.linkedShopAsk(tx, t.req) : undefined;

        const who = await ticketsRepo.userName(tx, claims.sub);
        await voidTicket(tx, id, reason, who, at);

        const changed: Changed[] = ["tkt", "rsv"];
        let tail = `the stock is free again at ${fromName}`;
        if (request) {
          // The store's pick is not the manager's decision. Back to whatever the approval
          // amounted to, with the ticket reference cleared so a fresh one can be issued.
          //
          // An explicit source guard, not a `canTransition` lookup: this edge is deliberately
          // absent from REQUEST_TRANSITIONS, because listing it would also re-open `approve`
          // - whose only guard is that same table - for a request holding a live ticket, and
          // through it a second ticket for stock already promised once. One door, one guard.
          assertRule(request.status === "Ticket issued", `${request.id} is ${request.status.toLowerCase()} - this ticket cannot be cancelled`);
          const back = approvedStatus(await ticketsRepo.requestLines(tx, request.id));
          await ticketsRepo.releaseRequest(tx, request.id, back);
          await appendHistory(tx, "request", request.id, back, who, at);
          changed.push("req");
          tail = `${request.id} is approved again and can be issued a new ticket`;
        }
        if (order) {
          // Same principle for the kitchen: the order was not delivered, so the board must not
          // keep saying it was. `Dispatched -> Ready` exists in the table for this and nothing else.
          assertRule(canTransition(PROD_ORDER_TRANSITIONS, order.status, "Ready"), `${order.id} is ${order.status.toLowerCase()} - this ticket cannot be cancelled`);
          await ticketsRepo.setProdOrderStatus(tx, order.id, "Ready");
          await appendHistory(tx, "prod_order", order.id, "Ready", who, at);
          changed.push("pord");
          tail = `${order.id} is back on the board, ready to dispatch again`;
        }
        if (ask) {
          // A granted shop ask that is withdrawn goes back on the asking shop's desk. Leaving it
          // at `Sent` would show the asker stock that is coming and the holder a document it has
          // just undone - and `answer` would refuse to grant it a second time.
          // No history row: a shop ask carries no `hist` on the wire, and a row nothing reads
          // back is not an audit trail. The ticket's own "Cancelled - <reason>" is the record.
          assertTransition(SHOP_ASK_TRANSITIONS, ask.status, "Asked", ask.id);
          await ticketsRepo.reopenShopAsk(tx, ask.id);
          changed.push("shopAsks");
        }

        await emitChanged(tx, changed);
        return { result: await reread(tx, id), changed, message: `${id} cancelled - ${tail}` };
      });
    },

    /**
     * Shop to shop, with no request behind it: one outlet promises stock to another and the
     * ticket is what the other collects against. It reserves and moves nothing - the movement
     * rule again, from the other side.
     */
    async transfer(claims: AccessClaims, body: TransferBody): Promise<WriteResponse<Ticket>> {
      return withTransaction(db, async (tx) => {
        assertRule(body.qty > 0, "Enter a quantity");
        const items = await loadItems(tx);
        const item = items[body.it];
        if (!item) throw new NotFoundError(`There is no item ${body.it}.`);
        assertRule(body.from !== body.to, "A shop transfer runs between two different outlets");
        const from = await lockLocation(tx, body.from);
        const to = await lockLocation(tx, body.to);
        // The store and the kitchen supply through a request and a ticket the manager sees;
        // this is the shortcut between two shop floors, and nothing else may use it.
        assertRule(from.type === "Outlet" && to.type === "Outlet", "A shop transfer runs between two different outlets");
        assertOpen(from);
        assertOpen(to);

        // Ids first, balance rows second (lib/ledger.ts's header): the number is taken before
        // the shelf is locked, so a sale and a transfer on the same shelf cannot sit each
        // holding one lock and waiting for the other. A refusal below rolls the number back.
        //
        // A side effect of that order is that the `tkt` sequence row already serialises two
        // transfers against each other, so the balance lock is not what makes the race test
        // pass. It is here because it is what makes the promise safe against everything that
        // does *not* allocate a ticket - a sale, a receipt - reading the same shelf.
        const at = new Date();
        const no = await allocateTicket(tx, at);
        await lockBalances(tx, [{ loc: body.from, it: body.it }]);
        const onHand = await ticketsRepo.balancesAt(tx, body.from, [body.it]);
        const held = await reservedAt(tx, body.from, [body.it]);
        const free = round3((onHand[body.it] ?? 0) - (held[`${body.from}:${body.it}`] ?? 0));
        assertRule(free >= body.qty, `${from.name} has only ${fq(free, item.u)} ${item.u} free to send`);

        const result = await writeTicket(tx, {
          refType: "shop_transfer", refId: "Shop transfer", from: body.from, to: body.to,
          lines: [{ it: body.it, qty: body.qty }], by: claims.sub, at,
        }, no);

        const changed = ["tkt", "rsv"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message: `${result.id} issued - ${fq(body.qty, item.u)} ${item.u} reserved at ${from.name} for ${to.name}` };
      });
    },
  };
}
