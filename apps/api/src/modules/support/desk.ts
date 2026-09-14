// desk.ts: the other end of the support desk — the admin-flagged account answering every
// ticket, whoever raised it. The same flow as `service.ts` (transaction, lock, rules, write,
// emit, return) on the same repo; the rules are `@rch/domain`'s `support.ts`. It is a second
// service beside the first rather than a branch inside it, because the two differ in exactly
// the thing every write decides first: `service.ts` finds a ticket only if it is the caller's
// own, and this finds any ticket at all.
//
// The desk's writes name `tickets` in `changed`, the collection the reporter's own screen reads,
// so a reply reaches the person who raised the ticket over the change stream while they watch.
import type { z } from "zod";
import type { DeskReplyBodySchema, SetTicketStatusBodySchema, SupportTicket, TicketStatus, WriteResponse } from "@rch/contract";
import { SUPPORT_TRANSITIONS, deskStatusAfterReply, mayDeskSet, mayReply } from "@rch/domain";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../lib/db.js";
import { withReadTransaction, withTransaction } from "../../lib/db.js";
import { NotFoundError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { assertRule, assertTransition } from "../../lib/rules.js";
import type { AccessClaims } from "../../plugins/auth.js";
import { supportRepo } from "./repo.js";

export type DeskReplyBody = z.infer<typeof DeskReplyBodySchema>;
export type SetDeskStatusBody = z.infer<typeof SetTicketStatusBodySchema>;

/** Where a ticket now stands, as the tail of the desk's sentence. "Waiting on you" is the
 *  reporter's word for it; the desk is told whom it is waiting on. */
const standing = (st: TicketStatus, reporter: string): string =>
  st === "Waiting on you" ? `waiting on ${reporter}` : st.toLowerCase();

export function createDeskService(db: Db) {
  /** Any ticket, locked — the desk's scope is the whole list, so the only miss is one that
   *  does not exist. */
  const any = async (tx: Tx, id: string) => {
    const row = await supportRepo.head(tx, id);
    if (!row) throw new NotFoundError(`There is no support ticket ${id}.`);
    return row;
  };

  return {
    async list(): Promise<SupportTicket[]> {
      return withReadTransaction(db, async (tx) => supportRepo.listAll(tx));
    },

    async reply(claims: AccessClaims, id: string, body: DeskReplyBody): Promise<WriteResponse<SupportTicket>> {
      return withTransaction(db, async (tx) => {
        const row = await any(tx, id);
        const text = body.body.trim();
        assertRule(text.length > 0, "Write a reply first");
        assertRule(mayReply(row.status), `${id} is closed — it takes no more replies`);
        // The status is decided before the message is written, so a refused move writes nothing.
        const next = deskStatusAfterReply(row.status, body.st);
        if (next !== row.status) assertTransition(SUPPORT_TRANSITIONS, row.status, next, id);
        // Under the admin's own name, so the reporter and anyone reading later know who answered.
        const me = await supportRepo.author(tx, claims.sub);
        await supportRepo.appendMessage(tx, id, "support", me.name, text);
        if (next !== row.status) await supportRepo.setStatus(tx, id, next);
        const result = (await supportRepo.one(tx, id))!;
        const changed = ["tickets"] as const;
        await emitChanged(tx, changed);
        return {
          result, changed: [...changed],
          message: next === row.status ? `Reply sent on ${id}` : `Reply sent on ${id} — now ${standing(next, result.by)}`,
        };
      });
    },

    async setStatus(id: string, body: SetDeskStatusBody): Promise<WriteResponse<SupportTicket>> {
      return withTransaction(db, async (tx) => {
        const row = await any(tx, id);
        assertRule(mayDeskSet(body.st), "A ticket cannot go back to open — it is open only until support first answers it");
        assertTransition(SUPPORT_TRANSITIONS, row.status, body.st, id);
        await supportRepo.setStatus(tx, id, body.st);
        const result = (await supportRepo.one(tx, id))!;
        const changed = ["tickets"] as const;
        await emitChanged(tx, changed);
        return { result, changed: [...changed], message: `${id} is now ${standing(body.st, result.by)}` };
      });
    },
  };
}
