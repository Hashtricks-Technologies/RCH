// Requests: the flow — transaction, rules, ids, reservations. Composes the helpers in
// apps/api/src/lib/; the arithmetic of a decision is `planApproval` in packages/domain.
//
// The movement rule, twice over (CLAUDE.md): approving a request writes approved quantities
// and nothing else, and issuing its ticket writes a hold at the central store and nothing
// else. No stock leaves a shelf here — that is the collector's scan, in the tickets module.
import type { z } from "zod";
import type {
  ApprovalResultSchema, ApproveRequestBodySchema, CreateRequestBodySchema, IssueResultSchema,
  RejectRequestBodySchema, StockRequest, WriteResponse,
} from "@rch/contract";
import { committed, planApproval, REQUEST_TRANSITIONS, round3 } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { allocateId } from "../../lib/ids.js";
import { lockBalances } from "../../lib/ledger.js";
import { loadMaster } from "../../lib/master.js";
import { reservedAt } from "../../lib/reservations.js";
import { assertRule, assertTransition } from "../../lib/rules.js";
import { allocateTicket, writeTicket } from "../../lib/tickets.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { requireLocOf } from "../../plugins/rbac.js";
import { requestsRepo } from "./repo.js";

export type CreateRequestBody = z.infer<typeof CreateRequestBodySchema>;
export type ApproveRequestBody = z.infer<typeof ApproveRequestBodySchema>;
export type RejectRequestBody = z.infer<typeof RejectRequestBodySchema>;
export type ApprovalResult = z.infer<typeof ApprovalResultSchema>;
export type IssueResult = z.infer<typeof IssueResultSchema>;

/** Every stock request is raised against the central store; there is no other shelf to ask. */
const STORE = "store";

export function createRequestsService(db: Db) {
  return {
    /**
     * One outlet's ask, in one transaction. The raiser's location is the token's, never the
     * body's — a counter operator cannot raise from another counter by editing a payload.
     */
    async create(claims: AccessClaims, body: CreateRequestBody): Promise<WriteResponse<StockRequest>> {
      return withTransaction(db, async (tx) => {
        const master = await loadMaster(tx);
        for (const l of body.lines) if (!master.items[l.it]) throw new NotFoundError(`There is no item ${l.it}.`);
        // A zero reaches the operator as the store's own sentence, not a schema's 400 — which
        // is why `QtySchema` in packages/contract leaves positivity to this line.
        assertRule(body.lines.every((l) => l.qty > 0), "Add at least one line with a quantity");
        // One item, one line. Two lines of the same item would be decided twice against the
        // same free-to-promise and shown as two shortfalls the counter cannot act on, and the
        // ticket would carry one folded line the request no longer matches. Refuse it where
        // the operator can still fix it — the draft screen — rather than reconcile it later.
        const repeated = body.lines.find((l, i) => body.lines.findIndex((x) => x.it === l.it) !== i);
        if (repeated) assertRule(false, `Combine the ${master.items[repeated.it]!.n} lines into one`);

        const at = new Date();
        const id = await allocateId(tx, "req", at);
        await requestsRepo.insertRequest(tx, {
          id, fromLoc: claims.loc, byUser: claims.sub, at, status: "Request sent",
          managerNote: body.note, urgent: body.urgent,
        });
        await requestsRepo.insertLines(tx, id, body.lines.map((l) => ({ it: l.it, qty: round3(l.qty) })));
        const who = await requestsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "request", id, "Request sent", who, at);

        const changed = ["req"] as const;
        await emitChanged(tx, changed);
        // One line names what was asked for; a longer one counts the lines, because a toast
        // that listed six items would be read by nobody.
        const n = body.lines.length;
        const message = n === 1
          ? `${id} raised for ${body.lines[0].qty} ${master.items[body.lines[0].it]!.n} — with the outlet manager now`
          : `${id} sent to the outlet manager — ${n} line${n > 1 ? "s" : ""}`;
        return { result: await requestsRepo.wire(tx, id), changed: [...changed], message };
      });
    },

    /** The counter's own withdrawal, while the manager has not decided yet. */
    async cancel(claims: AccessClaims, id: string): Promise<WriteResponse<StockRequest>> {
      return withTransaction(db, async (tx) => {
        const r = await requestsRepo.head(tx, id);
        if (!r) throw new NotFoundError(`There is no request ${id}.`);
        requireLocOf(claims, r.fromLoc, "your own counter");
        assertTransition(REQUEST_TRANSITIONS, r.status, "Cancelled", id);
        await requestsRepo.setStatus(tx, id, { status: "Cancelled" });
        const who = await requestsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "request", id, "Cancelled", who);

        const changed = ["req"] as const;
        await emitChanged(tx, changed);
        return { result: await requestsRepo.wire(tx, id), changed: [...changed], message: `${id} cancelled` };
      });
    },

    /**
     * The manager's decision. Never more than the counter asked for, never more than the
     * manager typed, and never more than the central store can still promise (C6).
     */
    async approve(claims: AccessClaims, id: string, body: ApproveRequestBody): Promise<WriteResponse<ApprovalResult>> {
      return withTransaction(db, async (tx) => {
        const r = await requestsRepo.head(tx, id);
        if (!r) throw new NotFoundError(`There is no request ${id}.`);
        const lines = await requestsRepo.lines(tx, id);
        // One decision per line, positionally. `planApproval` reads `appr[i]` beside `lines[i]`,
        // so a short array silently approves nothing on the lines it does not reach and a long
        // one carries a decision about a line that is not there — either way the manager sees a
        // request they did not decide. A stale screen is exactly how that arrives, so it is
        // refused here rather than reconciled afterwards.
        assertRule(body.appr.length === lines.length, `Give a quantity for each of the ${lines.length} lines`);
        const keys = lines.map((l) => l.it);
        // What the store may still promise: on hand, less open reservations, less what other
        // approvals have already committed (C6). Read before any write, and never trusted at
        // issue time — issue-ticket re-reads it under the balance locks.
        const stock = await requestsRepo.balancesAt(tx, STORE, keys);
        const held = await reservedAt(tx, STORE, keys);
        // The request being decided sits in "Request sent", which `committed()` does not
        // count, so there is nothing to exclude — and the guard below makes a second decision
        // impossible anyway.
        const open = await requestsRepo.openRequests(tx);
        const plan = planApproval(lines, body.appr, (it) => round3(
          (stock[it] ?? 0) - (held[`${STORE}:${it}`] ?? 0) - committed(open, it)));

        // Guard on what will actually be written, not on one representative status. All three
        // outcomes are listed under "Request sent", so a request already decided is refused
        // whichever way this one would have gone.
        assertTransition(REQUEST_TRANSITIONS, r.status, plan.st, id);
        await requestsRepo.setLineApprovals(tx, id, plan.lines);
        await requestsRepo.setStatus(tx, id, { status: plan.st, managerNote: body.note, approvedBy: claims.sub });
        const who = await requestsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "request", id, plan.st, who);

        const changed = ["req"] as const;
        await emitChanged(tx, changed);
        const message = plan.trimmed
          ? `${id} trimmed — the central store cannot cover the full quantity`
          : plan.st === "Rejected"
            ? `${id} rejected — no ticket will be issued`
            : `${id} ${plan.st.toLowerCase()} and forwarded to the store keeper`;
        return { result: { request: await requestsRepo.wire(tx, id), trimmed: plan.trimmed }, changed: [...changed], message };
      });
    },

    /** A refusal the counter can read. The reason is not optional — it is the whole message. */
    async reject(claims: AccessClaims, id: string, body: RejectRequestBody): Promise<WriteResponse<StockRequest>> {
      return withTransaction(db, async (tx) => {
        const r = await requestsRepo.head(tx, id);
        if (!r) throw new NotFoundError(`There is no request ${id}.`);
        assertRule(body.note.trim().length > 0, "Give a reason — the counter sees it on the request");
        assertTransition(REQUEST_TRANSITIONS, r.status, "Rejected", id);
        await requestsRepo.setStatus(tx, id, { status: "Rejected", managerNote: body.note, approvedBy: claims.sub });
        const who = await requestsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "request", id, "Rejected", who);

        const changed = ["req"] as const;
        await emitChanged(tx, changed);
        return { result: await requestsRepo.wire(tx, id), changed: [...changed], message: `${id} rejected` };
      });
    },

    /**
     * The store keeper turns an approval into a ticket: a number, an OTP, and a hold on the
     * shelf. Nothing moves — the collector's scan does that.
     */
    async issue(claims: AccessClaims, id: string): Promise<WriteResponse<IssueResult>> {
      return withTransaction(db, async (tx) => {
        const r = await requestsRepo.head(tx, id);
        if (!r) throw new NotFoundError(`There is no request ${id}.`);
        // Only "Manager approved" and "Partially approved" reach "Ticket issued", and neither
        // carries a ticket — so this also refuses a request that already has one.
        assertTransition(REQUEST_TRANSITIONS, r.status, "Ticket issued", id);

        const master = await loadMaster(tx);
        const approved = (await requestsRepo.lines(tx, id)).filter((l) => l.appr > 0);
        assertRule(approved.length > 0, "Nothing approved on this request");
        // Fold before the cover check, not after it (CLAUDE.md, "Dispatch is all-or-nothing":
        // a repeated item is folded into one line before the cover check). `POST /requests`
        // refuses a repeat outright, so only a row written before that rule — seeded, migrated,
        // hand-corrected — can arrive with one, and for it the check has to see the total:
        // `writeTicket` folds and reserves the sum, so two lines of 8 checked separately
        // against 12 on hand would hold 16. Same number checked, held and printed.
        const folded = new Map<string, number>();
        for (const l of approved) folded.set(l.it, round3((folded.get(l.it) ?? 0) + l.appr));
        const lines = [...folded].map(([it, qty]) => ({ it, qty }));

        // Ids before balance rows (lib/ledger.ts's header): take the ticket's number while
        // holding no shelf, so a sale that already holds the sequences row cannot deadlock us.
        const at = new Date();
        const no = await allocateTicket(tx, at);
        // The approval may be hours old and another ticket may have taken the same stock since.
        // Lock first, then read: two store keepers pressing together queue on these rows.
        await lockBalances(tx, lines.map((l) => ({ loc: STORE, it: l.it })));
        const stock = await requestsRepo.balancesAt(tx, STORE, lines.map((l) => l.it));
        const held = await reservedAt(tx, STORE, lines.map((l) => l.it));
        const short = lines.find((l) => round3((stock[l.it] ?? 0) - (held[`${STORE}:${l.it}`] ?? 0)) < l.qty);
        if (short) assertRule(false, `Not enough ${master.items[short.it]?.n ?? short.it} available to promise`);

        const ticket = await writeTicket(tx, { refType: "request", refId: id, from: STORE, to: r.fromLoc, lines, by: claims.sub, at }, no);
        await requestsRepo.setStatus(tx, id, { status: "Ticket issued", ticketId: ticket.id });
        const who = await requestsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "request", id, "Ticket issued", who, at);

        const changed = ["req", "tkt", "rsv"] as const;
        await emitChanged(tx, changed);
        const message = `${ticket.id} issued — ${master.locations[r.fromLoc]?.n ?? r.fromLoc} can collect against this ticket`;
        return { result: { request: await requestsRepo.wire(tx, id), ticket }, changed: [...changed], message };
      });
    },
  };
}
