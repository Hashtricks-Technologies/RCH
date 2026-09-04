// service.ts: the flow — transaction, lock, rules, write, emit, return. The rules themselves
// (which status may follow which, what a person at a screen may choose, what a reply does to a
// ticket) are `@rch/domain`'s `support.ts` and are never restated here.
//
// No `appendHistory` anywhere in this module, on purpose. A support ticket's history *is* its
// conversation: `support_messages` already holds who said what and when, and the status is a
// column beside it. A second trail in `document_history` would give the drawer two lists to
// render and two to keep in step.
import type { z } from "zod";
import type {
  RaiseTicketBodySchema, RateTicketBodySchema, ReplyToTicketBodySchema, SetTicketStatusBodySchema,
  SupportTicket, WriteResponse,
} from "@rch/contract";
import { SUPPORT_TRANSITIONS, mayRate, mayUserSet, statusAfterReply } from "@rch/domain";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../lib/db.js";
import { withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { allocateId } from "../../lib/ids.js";
import { assertRule, assertTransition } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { supportRepo } from "./repo.js";

export type RaiseTicketBody = z.infer<typeof RaiseTicketBodySchema>;
export type ReplyToTicketBody = z.infer<typeof ReplyToTicketBodySchema>;
export type SetTicketStatusBody = z.infer<typeof SetTicketStatusBodySchema>;
export type RateTicketBody = z.infer<typeof RateTicketBodySchema>;

export function createSupportService(db: Db) {
  /** Every write below is "own ticket only" (§9.2). A ticket somebody else raised is a 404, not a
   *  403: it is not that this person may not act on it, it is that it is not theirs to see — the
   *  same shape a role's missing module has, and it tells a fisherman nothing. */
  const mine = async (tx: Tx, id: string, sub: string) => {
    const row = await supportRepo.head(tx, id);
    if (!row || row.byUser !== sub) throw new NotFoundError(`There is no support ticket ${id}.`);
    return row;
  };

  return {
    /** Spec §9.2 scopes every support write to the caller's own tickets, so the list is scoped
     *  the same way: a row nobody may act on is a row nobody should be shown. Keyed on the user
     *  id in the token, never on a display name. */
    async list(claims: AccessClaims): Promise<SupportTicket[]> {
      return supportRepo.listFor(db, claims.sub);
    },

    async raise(claims: AccessClaims, body: RaiseTicketBody): Promise<WriteResponse<SupportTicket>> {
      return withTransaction(db, async (tx) => {
        const subject = body.subject.trim();
        assertRule(subject.length > 0, "Give the ticket a subject so support knows what it is about");
        const me = await supportRepo.author(tx, claims.sub);
        // Documents, then ids: nothing is locked here (the ticket does not exist yet), so the
        // sequence row is the first and only lock this write takes.
        const id = await allocateId(tx, "support");
        await supportRepo.insertTicket(tx, {
          id, topic: body.topic, subject, priority: body.priority, status: "Open",
          byUser: claims.sub, role: claims.role, loc: claims.loc, screen: body.screen.trim(),
        });
        // The browser has always taken a ticket with no detail — the Send button is disabled on an
        // empty subject and nothing else — so a first message is written only if there is one.
        const detail = body.body.trim();
        if (detail) await supportRepo.appendMessage(tx, id, "user", me.name, detail);
        const result = (await supportRepo.one(tx, id))!;
        const changed = ["tickets"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message: `${id} raised — support replies to urgent tickets within the hour` };
      });
    },

    async reply(claims: AccessClaims, id: string, body: ReplyToTicketBody): Promise<WriteResponse<SupportTicket>> {
      return withTransaction(db, async (tx) => {
        const row = await mine(tx, id, claims.sub);
        const text = body.body.trim();
        assertRule(text.length > 0, "Write a reply first");
        assertRule(row.status !== "Closed", `${id} is closed — raise a new ticket if it has come back`);
        const me = await supportRepo.author(tx, claims.sub);
        await supportRepo.appendMessage(tx, id, "user", me.name, text);
        const next = statusAfterReply(row.status);
        if (next !== row.status) {
          assertTransition(SUPPORT_TRANSITIONS, row.status, next, id);
          await supportRepo.setStatus(tx, id, next);
        }
        const result = (await supportRepo.one(tx, id))!;
        const changed = ["tickets"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message: `Reply sent on ${id}` };
      });
    },

    async setStatus(claims: AccessClaims, id: string, body: SetTicketStatusBody): Promise<WriteResponse<SupportTicket>> {
      return withTransaction(db, async (tx) => {
        const row = await mine(tx, id, claims.sub);
        assertRule(mayUserSet(body.st),
          `Only support moves a ticket to ${body.st.toLowerCase()} — you can mark it resolved or close it`);
        assertTransition(SUPPORT_TRANSITIONS, row.status, body.st, id);
        await supportRepo.setStatus(tx, id, body.st);
        const result = (await supportRepo.one(tx, id))!;
        const changed = ["tickets"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message: `${id} — ${body.st.toLowerCase()}` };
      });
    },

    async rate(claims: AccessClaims, id: string, body: RateTicketBody): Promise<WriteResponse<SupportTicket>> {
      return withTransaction(db, async (tx) => {
        const row = await mine(tx, id, claims.sub);
        assertRule(mayRate(row.status), `${id} is not finished yet — rate it once support has resolved it`);
        await supportRepo.setRating(tx, id, body.rating);
        const result = (await supportRepo.one(tx, id))!;
        const changed = ["tickets"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message: `Thank you — ${body.rating} out of 5 recorded against ${id}` };
      });
    },
  };
}
