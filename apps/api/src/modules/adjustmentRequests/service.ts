// Adjustment requests: the flow - transaction, rules, ids, the shared write. The counter raises
// an ask against its own shelf; the outlet manager decides it, and approving one both decides
// the request and writes the `ADJ-` document in the same step - there is no ticket stage after
// it, because a write-off has no hand-off to scan (CLAUDE.md's movement rule is written for one).
import type { z } from "zod";
import type {
  AdjustmentRequest, ApproveAdjustmentRequestResultSchema, CreateAdjustmentRequestBodySchema,
  LocKey, RejectAdjustmentRequestBodySchema, WriteResponse,
} from "@rch/contract";
import { ADJUSTMENT_REQUEST_TRANSITIONS, round3 } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { writeAdjustment } from "../../lib/adjustments.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { allocateId } from "../../lib/ids.js";
import { loadMaster } from "../../lib/master.js";
import { assertRule, assertTransition } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { requireLocOf } from "../../plugins/rbac.js";
import { adjustmentRequestsRepo } from "./repo.js";

export type CreateAdjustmentRequestBody = z.infer<typeof CreateAdjustmentRequestBodySchema>;
export type RejectAdjustmentRequestBody = z.infer<typeof RejectAdjustmentRequestBodySchema>;
export type ApproveAdjustmentRequestResult = z.infer<typeof ApproveAdjustmentRequestResultSchema>;

export function createAdjustmentRequestsService(db: Db) {
  return {
    /** One outlet's ask, in one transaction. The raiser's location is the token's, never the
     *  body's - a counter cannot raise against another counter's shelf by editing a payload. */
    async create(claims: AccessClaims, body: CreateAdjustmentRequestBody): Promise<WriteResponse<AdjustmentRequest>> {
      return withTransaction(db, async (tx) => {
        const master = await loadMaster(tx);
        for (const l of body.lines) if (!master.items[l.it]) throw new NotFoundError(`There is no item ${l.it}.`);
        // One item, one line - the same reason `createRequest` refuses a repeat outright rather
        // than folding it: two lines of the same item are two halves of one correction, and a
        // manager deciding them separately could approve one and reject the other of what is
        // really a single ask.
        const repeated = body.lines.find((l, i) => body.lines.findIndex((x) => x.it === l.it) !== i);
        if (repeated) assertRule(false, `Combine the ${master.items[repeated.it]!.n} lines into one`);
        const lines = body.lines.map((l) => ({ it: l.it, qty: round3(l.qty) })).filter((l) => l.qty !== 0);
        assertRule(lines.length > 0, "Enter a quantity to write off or count up on at least one line");

        const at = new Date();
        const id = await allocateId(tx, "adj_req", at);
        await adjustmentRequestsRepo.insertRequest(tx, {
          id, loc: claims.loc, reason: body.reason, note: body.note, byUser: claims.sub, at, status: "Request sent",
        });
        await adjustmentRequestsRepo.insertLines(tx, id, lines);
        const who = await adjustmentRequestsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "adjustment_request", id, "Request sent", who, at);

        const changed = ["adjReq"] as const;
        await emitChanged(tx, changed);
        return {
          result: await adjustmentRequestsRepo.wire(tx, id), changed: [...changed],
          message: `${id} sent to the outlet manager`,
        };
      });
    },

    /** The counter's own withdrawal while the manager has not decided yet, or the manager
     *  withdrawing a request they have not yet acted on themselves. A manager is hospital-wide;
     *  a counter scopes to its own outlet, exactly as `cancelRequest` does. */
    async cancel(claims: AccessClaims, id: string): Promise<WriteResponse<AdjustmentRequest>> {
      return withTransaction(db, async (tx) => {
        const r = await adjustmentRequestsRepo.head(tx, id);
        if (!r) throw new NotFoundError(`There is no adjustment request ${id}.`);
        if (claims.role !== "manager") requireLocOf(claims, r.loc, "your own counter");
        assertTransition(ADJUSTMENT_REQUEST_TRANSITIONS, r.status, "Cancelled", id);
        await adjustmentRequestsRepo.setStatus(tx, id, { status: "Cancelled" });
        const who = await adjustmentRequestsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "adjustment_request", id, "Cancelled", who);

        const changed = ["adjReq"] as const;
        await emitChanged(tx, changed);
        return { result: await adjustmentRequestsRepo.wire(tx, id), changed: [...changed], message: `${id} cancelled` };
      });
    },

    /**
     * The manager's decision to say yes: writes the `ADJ-` document there and then, under the
     * same lock `writeAdjustment` takes on the shelf's balances - there is nothing to issue
     * afterwards, so this is both the decision and the movement.
     */
    async approve(claims: AccessClaims, id: string): Promise<WriteResponse<ApproveAdjustmentRequestResult>> {
      return withTransaction(db, async (tx) => {
        const r = await adjustmentRequestsRepo.head(tx, id);
        if (!r) throw new NotFoundError(`There is no adjustment request ${id}.`);
        assertTransition(ADJUSTMENT_REQUEST_TRANSITIONS, r.status, "Approved", id);
        const lines = await adjustmentRequestsRepo.lines(tx, id);

        const master = await loadMaster(tx);
        const { adjustment, message } = await writeAdjustment(tx, master, {
          loc: r.loc as LocKey, reason: r.reason, note: r.note, lines, by: claims.sub, at: new Date(),
        });

        await adjustmentRequestsRepo.setStatus(tx, id, { status: "Approved", approvedBy: claims.sub, adjustmentId: adjustment.id });
        const who = await adjustmentRequestsRepo.userName(tx, claims.sub);
        await appendHistory(tx, "adjustment_request", id, "Approved", who);

        const changed = ["adjReq", "stock", "adjustments"] as const;
        await emitChanged(tx, changed);
        return {
          result: { request: await adjustmentRequestsRepo.wire(tx, id), adjustment },
          changed: [...changed],
          message: `${id} approved - ${message}`,
        };
      });
    },

    /** A refusal the counter can read. The reason is not optional - it is the whole message. */
    async reject(claims: AccessClaims, id: string, body: RejectAdjustmentRequestBody): Promise<WriteResponse<AdjustmentRequest>> {
      return withTransaction(db, async (tx) => {
        const r = await adjustmentRequestsRepo.head(tx, id);
        if (!r) throw new NotFoundError(`There is no adjustment request ${id}.`);
        assertRule(body.note.trim().length > 0, "Give a reason - the counter sees it on the request");
        assertTransition(ADJUSTMENT_REQUEST_TRANSITIONS, r.status, "Rejected", id);
        await adjustmentRequestsRepo.setStatus(tx, id, { status: "Rejected", approvedBy: claims.sub });
        await appendHistory(tx, "adjustment_request", id, `Rejected - ${body.note.trim()}`, await adjustmentRequestsRepo.userName(tx, claims.sub));

        const changed = ["adjReq"] as const;
        await emitChanged(tx, changed);
        return { result: await adjustmentRequestsRepo.wire(tx, id), changed: [...changed], message: `${id} rejected` };
      });
    },
  };
}
