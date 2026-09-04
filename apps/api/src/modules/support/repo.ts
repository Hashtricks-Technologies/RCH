// repo.ts: SQL only. The service opens the transaction; this file never does.
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { SupportTicket } from "@rch/contract";
import type { Db } from "../../db/client.js";
import type { Tx } from "../../lib/db.js";
import * as s from "../../db/schema/index.js";

/** Rows -> the wire shape, shared by the list and (Task 5) by every write's `result`. */
export function toWire(head: typeof s.supportTickets.$inferSelect, msgs: (typeof s.supportMessages.$inferSelect)[], byName: string): SupportTicket {
  return {
    id: head.id, topic: head.topic, subject: head.subject, priority: head.priority, st: head.status,
    by: byName, role: head.role, loc: head.loc as SupportTicket["loc"],
    at: head.at.toISOString(), screen: head.screen,
    messages: msgs.map((m) => ({
      id: m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id,
      from: m.from, who: m.who, at: m.at.toISOString(), body: m.body,
    })),
    ...(head.rating === null ? {} : { rating: head.rating as SupportTicket["rating"] }),
  };
}

export const supportRepo = {
  /** The caller's own tickets, newest first, each with its conversation oldest first. */
  async listFor(db: Db | Tx, userId: string): Promise<SupportTicket[]> {
    const heads = await db.select().from(s.supportTickets).where(eq(s.supportTickets.byUser, userId))
      .orderBy(desc(s.supportTickets.at), desc(s.supportTickets.id));
    if (heads.length === 0) return [];
    const ids = heads.map((h) => h.id);
    const msgs = await db.select().from(s.supportMessages)
      .where(inArray(s.supportMessages.ticketId, ids))
      .orderBy(asc(s.supportMessages.at), asc(s.supportMessages.id));
    const [me] = await db.select({ name: s.users.name }).from(s.users).where(eq(s.users.id, userId));
    // Grouped inline. `readers/documents.ts:10` has a private `groupBy` that does exactly this,
    // and it stays private: moving it into `lib/` would mean this wave-1 task editing the reader
    // Task 4 owns in wave 2, for a three-line helper. A shared `lib/groupBy.ts` is the tidy, and
    // it is recorded as one rather than smuggled in here.
    const byTicket = new Map<string, typeof msgs>();
    for (const m of msgs) {
      const list = byTicket.get(m.ticketId);
      if (list) list.push(m); else byTicket.set(m.ticketId, [m]);
    }
    return heads.map((h) => toWire(h, byTicket.get(h.id) ?? [], me?.name ?? userId));
  },
};
