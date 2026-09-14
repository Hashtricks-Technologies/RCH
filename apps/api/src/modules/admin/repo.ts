// repo.ts: SQL only. No rules, no transaction of its own — service.ts opens the transaction
// and passes it in as `tx`.
import { asc, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AdminAction } from "@rch/contract";
import type { Reader, Tx } from "../../lib/db.js";
import { adminActions, users } from "../../db/schema/index.js";

export type UserRow = typeof users.$inferSelect;

export const adminRepo = {
  /** Every account, active and inactive alike, employee number ascending. */
  async list(db: Reader): Promise<UserRow[]> {
    return db.select().from(users).orderBy(asc(users.empNo));
  },
  async byId(db: Reader, id: string): Promise<UserRow | undefined> {
    return (await db.select().from(users).where(eq(users.id, id)))[0];
  },
  /** One line per write, in the same transaction as the change it records.
   *  `id` is minted by the caller (a fresh UUID) — this table has no `sequences` row, on
   *  purpose: nothing ever reads its id back, so there is nothing for a gapless series to
   *  serve. */
  async logAction(tx: Tx, row: { id: string; actorId: string; action: string; targetId: string; details: Record<string, unknown> }): Promise<void> {
    await tx.insert(adminActions).values(row);
  },
  /** The fifty most recent actions, newest first, actor and target already resolved to names —
   *  the one join this module makes, so the page never has to look either id up itself. */
  async recentActions(db: Reader): Promise<AdminAction[]> {
    const actor = alias(users, "actor");
    const target = alias(users, "target");
    const rows = await db.select({
      at: adminActions.at, action: adminActions.action, details: adminActions.details,
      actorName: actor.name, targetName: target.name,
    })
      .from(adminActions)
      .innerJoin(actor, eq(actor.id, adminActions.actorId))
      .innerJoin(target, eq(target.id, adminActions.targetId))
      .orderBy(desc(adminActions.at))
      .limit(50);
    return rows.map((r) => ({
      at: r.at.toISOString(), action: r.action as AdminAction["action"], actor: r.actorName, target: r.targetName,
      details: r.details as Record<string, unknown>,
    }));
  },
};
