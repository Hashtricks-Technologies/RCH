// Requisitions: the flow — transaction, rules, ids, history. Composes the helpers in
// apps/api/src/lib/; the arithmetic of a decision is `planPrqApproval` in packages/domain.
//
// Nothing here touches stock or `ordered_qty`. A requisition records what the central store
// wants bought; the claim a purchase order puts on it, and the goods that eventually arrive,
// are the purchase-order and goods-receipt modules' business.
import type { z } from "zod";
import type {
  ApproveRequisitionBodySchema, CreateRequisitionBodySchema, DeclineRequisitionBodySchema,
  Requisition, WriteResponse,
} from "@rch/contract";
import { planPrqApproval, REQUISITION_TRANSITIONS, round3 } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { allocateId } from "../../lib/ids.js";
import { loadMaster } from "../../lib/master.js";
import { assertRule, assertTransition } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { requisitionsRepo } from "./repo.js";

export type CreateRequisitionBody = z.infer<typeof CreateRequisitionBodySchema>;
export type ApproveRequisitionBody = z.infer<typeof ApproveRequisitionBodySchema>;
export type DeclineRequisitionBody = z.infer<typeof DeclineRequisitionBodySchema>;

const REASON = "Give a reason — the store keeper sees it on the requisition";

export function createRequisitionsService(db: Db) {
  return {
    /** The central store's ask, in one transaction. */
    async create(claims: AccessClaims, body: CreateRequisitionBody): Promise<WriteResponse<Requisition>> {
      return withTransaction(db, async (tx) => {
        const master = await loadMaster(tx);
        for (const l of body.lines) if (!master.items[l.it]) throw new NotFoundError(`There is no item ${l.it}.`);
        assertRule(body.lines.every((l) => l.qty > 0), "Add at least one line before sending");
        // One item, one line — the same rule `POST /requests` keeps, and for the same reason:
        // two lines of one item would be decided twice, claimed twice and received twice, and
        // the store keeper can still fix it on the draft screen.
        const repeated = body.lines.find((l, i) => body.lines.findIndex((x) => x.it === l.it) !== i);
        if (repeated) assertRule(false, `Combine the ${master.items[repeated.it]!.n} lines into one`);

        const at = new Date();
        const id = await allocateId(tx, "prq", at);
        await requisitionsRepo.insert(tx, { id, byUser: claims.sub, at, status: "Sent", note: body.note });
        await requisitionsRepo.insertLines(tx, id, body.lines.map((l) => ({ it: l.it, qty: round3(l.qty) })));
        const who = await requisitionsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "requisition", id, "Sent", who, at);

        const changed = ["prq"] as const;
        await emitChanged(tx, changed);
        return { result: await requisitionsRepo.wire(tx, id), changed: [...changed], message: `${id} sent to procurement` };
      });
    },

    /**
     * The buyer's decision. Never more than the store keeper asked for and never more than the
     * buyer typed — and never netted against the central store's own shelf, which has nothing to
     * do with what a vendor can supply. `ordered_qty` is untouched: the procurement list is
     * approved less ordered, and a decision that reset the claim would hand a live order's
     * quantity back to the list.
     */
    async approve(claims: AccessClaims, id: string, body: ApproveRequisitionBody): Promise<WriteResponse<Requisition>> {
      return withTransaction(db, async (tx) => {
        const p = await requisitionsRepo.head(tx, id);
        if (!p) throw new NotFoundError(`There is no requisition ${id}.`);
        const lines = await requisitionsRepo.lines(tx, id);
        // One decision per line, positionally: a short array silently declines the lines it does
        // not reach, which is not a decision the buyer necessarily meant to make (spec §16).
        assertRule(body.appr.length === lines.length, `Give a quantity for each of the ${lines.length} lines`);
        const plan = planPrqApproval(lines, body.appr);
        // Zeroing every line is a decline in all but name, and a decline always carries a reason.
        if (plan.st === "Declined") assertRule(body.note.trim().length > 0, REASON);
        // Guard on what will actually be written: all three outcomes hang off "Sent", so a
        // requisition already decided is refused whichever way this one would have gone.
        assertTransition(REQUISITION_TRANSITIONS, p.status, plan.st, id);

        await requisitionsRepo.setLineApprovals(tx, id, plan.lines);
        await requisitionsRepo.setDecision(tx, id, { status: plan.st, approvalNote: body.note, approvedBy: claims.sub });
        const who = await requisitionsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "requisition", id, plan.st, who);

        const changed = ["prq"] as const;
        await emitChanged(tx, changed);
        const n = plan.lines.filter((l) => l.appr > 0).length;
        const message = plan.st === "Declined"
          ? `${id} declined — nothing goes on the procurement list`
          : `${id} ${plan.st.toLowerCase()} — ${n} line(s) on the procurement list`;
        return { result: await requisitionsRepo.wire(tx, id), changed: [...changed], message };
      });
    },

    /** A plain refusal. It approves nothing, so every line's shortfall is the full ask — the
     *  same rows an all-zero approval writes. */
    async decline(claims: AccessClaims, id: string, body: DeclineRequisitionBody): Promise<WriteResponse<Requisition>> {
      return withTransaction(db, async (tx) => {
        const p = await requisitionsRepo.head(tx, id);
        if (!p) throw new NotFoundError(`There is no requisition ${id}.`);
        assertRule(body.note.trim().length > 0, REASON);
        assertTransition(REQUISITION_TRANSITIONS, p.status, "Declined", id);
        const lines = await requisitionsRepo.lines(tx, id);
        await requisitionsRepo.setLineApprovals(tx, id, lines.map((l) => ({ appr: 0, short: l.qty })));
        await requisitionsRepo.setDecision(tx, id, { status: "Declined", approvalNote: body.note, approvedBy: claims.sub });
        const who = await requisitionsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "requisition", id, "Declined", who);

        const changed = ["prq"] as const;
        await emitChanged(tx, changed);
        return { result: await requisitionsRepo.wire(tx, id), changed: [...changed], message: `${id} declined` };
      });
    },
  };
}
