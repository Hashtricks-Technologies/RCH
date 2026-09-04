// Tickets: the movement rule in code. Approval authorises and the scan moves — so a handover
// is the one place stock leaves a location on this path, a receipt the one place it lands, and
// between the two it is in transit and owned by neither.
import type { z } from "zod";
import type { HandoverBodySchema, Ticket, TransferBodySchema, WriteResponse } from "@rch/contract";
import { canTransition, fq, REQUEST_TRANSITIONS, round3, TICKET_TRANSITIONS } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction, type Tx } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { lockBalances, postMoves } from "../../lib/ledger.js";
import { loadMaster } from "../../lib/master.js";
import { releaseForTicket, reservedAt } from "../../lib/reservations.js";
import { assertRule, assertTransition } from "../../lib/rules.js";
import { allocateTicket, readTicket, writeTicket } from "../../lib/tickets.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { requireLocOf } from "../../plugins/rbac.js";
import { ticketsRepo } from "./repo.js";

export type HandoverBody = z.infer<typeof HandoverBodySchema>;
export type TransferBody = z.infer<typeof TransferBodySchema>;

/** The ticket as it now stands. The row is locked and was just written, so this cannot miss;
 *  the guard is here because `readTicket` answers for any id, including one that never was. */
async function reread(tx: Tx, id: string): Promise<Ticket> {
  const t = await readTicket(tx, id);
  if (!t) throw new NotFoundError(`There is no ticket ${id}.`);
  return t;
}

export function createTicketsService(db: Db) {
  return {
    /**
     * The scan at the window. One transaction: the OTP (or the labelled override), the
     * `ticket_out` moves at the sending location, the release of the hold those moves replace,
     * and the request behind the ticket moved on. A refusal anywhere rolls all of it back, so
     * a wrong OTP moves nothing.
     */
    async handover(claims: AccessClaims, id: string, body: HandoverBody): Promise<WriteResponse<Ticket>> {
      return withTransaction(db, async (tx) => {
        const t = await ticketsRepo.head(tx, id);
        if (!t) throw new NotFoundError(`There is no ticket ${id}.`);
        requireLocOf(claims, t.from, "the location the ticket is issued from");
        assertTransition(TICKET_TRANSITIONS, t.st, "Collected", id);

        // The OTP is quoted by the collector and typed at the window. Omitting it is the
        // labelled supervisor override — allowed to the store and the kitchen only (spec §8.3)
        // and written to document_history, because the ticket's own row carries no prose and
        // an override that left no trace could not be audited afterwards.
        const override = body.otp === undefined;
        if (body.otp !== undefined) assertRule(body.otp.trim() === t.otp, `That OTP does not match ${id}. Ask the collector to read it again.`);
        else assertRule(claims.role === "store" || claims.role === "prod", "Only the store or the kitchen may hand over without the OTP");

        const at = new Date();
        const master = await loadMaster(tx);
        const from = master.locations[t.from];
        const to = master.locations[t.to];

        // The scan moves: the stock leaves `from` here and belongs to nobody until it is received.
        await postMoves(tx, t.lines.map((l) => ({ loc: t.from, it: l.it, qty: -l.qty, kind: "ticket_out" as const, refType: "ticket", refId: id, by: claims.sub, at })));
        // postMoves holds the locks; this read is the guarantee. The cover check at issue time
        // was the courtesy, and a sale on the same shelf may have happened since.
        const after = await ticketsRepo.balancesAt(tx, t.from, t.lines.map((l) => l.it));
        for (const l of t.lines) {
          const item = master.items[l.it];
          const unit = item?.u ?? "nos";
          assertRule((after[l.it] ?? 0) >= 0, `${to.n} cannot collect ${fq(l.qty, unit)} ${unit} of ${item?.n ?? l.it} — ${from.n} no longer has it`);
        }
        // The hold has done its work and the moves have taken its place.
        await releaseForTicket(tx, id, at);
        await ticketsRepo.setStatus(tx, id, { status: "Collected", collectedAt: at });

        const who = await ticketsRepo.userName(tx, claims.sub);
        if (override) await appendHistory(tx, "ticket", id, "Handed over — supervisor override", who, at);
        const linked = await ticketsRepo.linkedRequest(tx, t.req);
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
          message: override
            ? `${id} handed over on a supervisor override — stock is in transit to ${to.n}`
            : `${id} handed over — stock is in transit to ${to.n}`,
        };
      });
    },

    /** The scan on the shelf: the mirror of handover, and the end of the request behind it. */
    async receive(claims: AccessClaims, id: string): Promise<WriteResponse<Ticket>> {
      return withTransaction(db, async (tx) => {
        const t = await ticketsRepo.head(tx, id);
        if (!t) throw new NotFoundError(`There is no ticket ${id}.`);
        requireLocOf(claims, t.to, "the location the ticket is coming to");
        assertTransition(TICKET_TRANSITIONS, t.st, "Received", id);

        const at = new Date();
        const master = await loadMaster(tx);
        const to = master.locations[t.to];
        // Booking stock in cannot drive a balance below zero, so this is the one movement with
        // no post-lock re-read behind it — the only asymmetry between the two ends of a ticket.
        await postMoves(tx, t.lines.map((l) => ({ loc: t.to, it: l.it, qty: l.qty, kind: "ticket_in" as const, refType: "ticket", refId: id, by: claims.sub, at })));
        await ticketsRepo.setStatus(tx, id, { status: "Received", receivedAt: at });

        const who = await ticketsRepo.userName(tx, claims.sub);
        const linked = await ticketsRepo.linkedRequest(tx, t.req);
        // The request closes here, and the word printed on its trail is the ticket's own
        // "Received" — the word the operator reads at the shelf, kept verbatim from the store.
        if (linked && canTransition(REQUEST_TRANSITIONS, linked.status, "Closed")) {
          await ticketsRepo.setRequestStatus(tx, linked.id, "Closed");
          await appendHistory(tx, "request", linked.id, "Received", who, at);
        }

        const changed = ["tkt", "req", "stock"] as const;
        await emitChanged(tx, changed);
        return { result: await reread(tx, id), changed: [...changed], message: `Received at ${to.n} — stock is on the shelf` };
      });
    },

    /**
     * Shop to shop, with no request behind it: one outlet promises stock to another and the
     * ticket is what the other collects against. It reserves and moves nothing — the movement
     * rule again, from the other side.
     */
    async transfer(claims: AccessClaims, body: TransferBody): Promise<WriteResponse<Ticket>> {
      return withTransaction(db, async (tx) => {
        assertRule(body.qty > 0, "Enter a quantity");
        const master = await loadMaster(tx);
        const item = master.items[body.it];
        if (!item) throw new NotFoundError(`There is no item ${body.it}.`);
        const from = master.locations[body.from];
        const to = master.locations[body.to];
        // The store and the kitchen supply through a request and a ticket the manager sees;
        // this is the shortcut between two shop floors, and nothing else may use it.
        assertRule(body.from !== body.to && from?.type === "Outlet" && to?.type === "Outlet", "A shop transfer runs between two different outlets");

        // Ids first, balance rows second (lib/ledger.ts's header): the number is taken before
        // the shelf is locked, so a sale and a transfer on the same shelf cannot sit each
        // holding one lock and waiting for the other. A refusal below rolls the number back.
        //
        // A side effect of that order is that the `tkt` sequence row already serialises two
        // transfers against each other, so the balance lock is not what makes the race test
        // pass. It is here because it is what makes the promise safe against everything that
        // does *not* allocate a ticket — a sale, a receipt — reading the same shelf.
        const at = new Date();
        const no = await allocateTicket(tx, at);
        await lockBalances(tx, [{ loc: body.from, it: body.it }]);
        const onHand = await ticketsRepo.balancesAt(tx, body.from, [body.it]);
        const held = await reservedAt(tx, body.from, [body.it]);
        const free = round3((onHand[body.it] ?? 0) - (held[`${body.from}:${body.it}`] ?? 0));
        assertRule(free >= body.qty, `${from.n} has only ${fq(free, item.u)} ${item.u} free to send`);

        const result = await writeTicket(tx, {
          refType: "shop_transfer", refId: "Shop transfer", from: body.from, to: body.to,
          lines: [{ it: body.it, qty: body.qty }], by: claims.sub, at,
        }, no);

        const changed = ["tkt", "rsv"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message: `${result.id} issued — ${fq(body.qty, item.u)} ${item.u} reserved at ${from.n} for ${to.n}` };
      });
    },
  };
}
