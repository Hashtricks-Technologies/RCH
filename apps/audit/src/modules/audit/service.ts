// service.ts: the flow. A filter in the operator's terms (IST days, an area of the hospital)
// becomes one in the log's terms (instants, action names) here, and nowhere else.
import { actionsInGroup, type AuditEntry, type AuditPage, type AuditQuery } from "@rch/contract";
import type { Db } from "../../db/client.js";
import { withReadTransaction } from "../../lib/db.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { istDay, istDayStart, nextIstDay } from "../../lib/time.js";
import { auditRepo, type AuditFilter } from "./repo.js";

function dayStart(day: string): Date {
  const start = istDayStart(day);
  if (!start) throw new ValidationError(`There is no day ${day} on the calendar.`);
  return start;
}

/**
 * - `to` defaults to today in Asia/Kolkata, and `from` defaults to `to`: nothing asked for is today,
 *   a lone `to` is that one day, and a lone `from` runs through today.
 * - `to` is inclusive: the filter ends at the IST midnight after it.
 * - `group` is the set of actions `AUDIT_LABELS` files under it; with `action` as well the two
 *   intersect, so an action outside the area finds nothing rather than widening it.
 */
function toFilter(q: AuditQuery): AuditFilter {
  const to = q.to ?? istDay(new Date());
  const from = q.from ?? to;
  const fromAt = dayStart(from);
  const toStart = dayStart(to);
  if (fromAt.getTime() > toStart.getTime()) throw new ValidationError(`The period cannot start on ${from}, after it ends on ${to}.`);
  let actions = q.group ? actionsInGroup(q.group) : undefined;
  if (q.action) actions = actions ? actions.filter((a) => a === q.action) : [q.action];
  const text = q.q?.trim();
  return {
    fromAt, toAt: nextIstDay(toStart),
    actor: q.actor, role: q.role, loc: q.loc, actions, outcome: q.outcome,
    q: text ? text : undefined, before: q.before, limit: q.limit,
  };
}

export function createAuditService(db: Db) {
  return {
    /** The page and the counts over the whole filter, in one read-only transaction: one connection,
     *  queries awaited one after the other. */
    async list(q: AuditQuery): Promise<AuditPage> {
      const f = toFilter(q);
      return withReadTransaction(db, async (tx) => {
        const { rows, next } = await auditRepo.page(tx, f);
        const counts = await auditRepo.counts(tx, f);
        return { rows, next, counts };
      });
    },

    async entry(id: number): Promise<AuditEntry> {
      const entry = await auditRepo.entry(db, id);
      if (!entry) throw new NotFoundError(`There is no audit entry ${id}.`);
      return entry;
    },
  };
}
