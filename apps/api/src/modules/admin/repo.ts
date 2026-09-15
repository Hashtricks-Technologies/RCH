// repo.ts: SQL only. No rules, no transaction of its own - service.ts opens the transaction
// and passes it in as `tx`.
import { and, asc, desc, eq, inArray, like, ne, notLike, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AdminAction } from "@rch/contract";
import { QUARANTINE } from "@rch/contract";
import { HOLDS_OUTLET, holding, type OutletBlockers } from "@rch/domain";
import type { Reader, Tx } from "../../lib/db.js";
import { adminActions, locations, prodOrders, productRequests, shopAsks, stockBalances, stockRequests, tickets, users } from "../../db/schema/index.js";

export type UserRow = typeof users.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;

export const adminRepo = {
  /** Every account, active and inactive alike, employee number ascending. */
  async list(db: Reader): Promise<UserRow[]> {
    return db.select().from(users).orderBy(asc(users.empNo));
  },
  async byId(db: Reader, id: string): Promise<UserRow | undefined> {
    return (await db.select().from(users).where(eq(users.id, id)))[0];
  },
  async byIdForUpdate(tx: Tx, id: string): Promise<UserRow | undefined> {
    return (await tx.select().from(users).where(eq(users.id, id)).for("update"))[0];
  },
  /** One line per write, in the same transaction as the change it records.
   *  `id` is minted by the caller (a fresh UUID) - this table has no `sequences` row, on
   *  purpose: nothing ever reads its id back, so there is nothing for a gapless series to
   *  serve. */
  async logAction(tx: Tx, row: { id: string; actorId: string; action: string; targetId: string | null; targetName: string; details: Record<string, unknown> }): Promise<void> {
    await tx.insert(adminActions).values(row);
  },
  /** The fifty most recent actions, newest first, actor and target already resolved to names -
   *  the one join this module makes, so the page never has to look either id up itself. The
   *  target is a left join onto its current name, falling back to the name stored on the line:
   *  a deleted account has no row to join, and the log still says who it was. One feed serves
   *  two tabs: `kind` picks account actions or outlet actions, never both at once. */
  async recentActions(db: Reader, kind: "accounts" | "outlets"): Promise<AdminAction[]> {
    const actor = alias(users, "actor");
    const target = alias(users, "target");
    const rows = await db.select({
      at: adminActions.at, action: adminActions.action, details: adminActions.details,
      actorName: actor.name, targetName: sql<string>`coalesce(${target.name}, ${adminActions.targetName})`,
    })
      .from(adminActions)
      .innerJoin(actor, eq(actor.id, adminActions.actorId))
      .leftJoin(target, eq(target.id, adminActions.targetId))
      .where(kind === "outlets" ? like(adminActions.action, "outlet_%") : notLike(adminActions.action, "outlet_%"))
      .orderBy(desc(adminActions.at))
      .limit(50);
    return rows.map((r) => ({
      at: r.at.toISOString(), action: r.action as AdminAction["action"], actor: r.actorName, target: r.targetName,
      details: r.details as Record<string, unknown>,
    }));
  },

  /** Every location but the rejected-goods shelf, by name, each with the active ordinary accounts
   *  based there. The super admin's own row carries a placeholder location and is not counted. */
  async locations(db: Reader): Promise<Array<LocationRow & { staff: number }>> {
    const rows = await db.select().from(locations).where(ne(locations.key, QUARANTINE)).orderBy(asc(locations.name), asc(locations.key));
    const posted = await db.select({ loc: users.loc, n: sql<number>`count(*)::int` }).from(users)
      .where(and(eq(users.active, true), eq(users.admin, false))).groupBy(users.loc);
    const staff = new Map(posted.map((p) => [p.loc, Number(p.n)]));
    return rows.map((r) => ({ ...r, staff: staff.get(r.key) ?? 0 }));
  },
  async locationKeys(tx: Tx): Promise<string[]> {
    return (await tx.select({ key: locations.key }).from(locations)).map((r) => r.key);
  },
  async locationForUpdate(tx: Tx, key: string): Promise<LocationRow | undefined> {
    return (await tx.select().from(locations).where(eq(locations.key, key)).for("update"))[0];
  },
  async staffAt(tx: Tx, key: string): Promise<string[]> {
    const rows = await tx.select({ emp: users.empNo }).from(users)
      .where(and(eq(users.loc, key), eq(users.active, true), eq(users.admin, false))).orderBy(asc(users.empNo));
    return rows.map((r) => r.emp);
  },
  /** Serialises outlet creation: the key is read from the table and then written to it, and two
   *  opens at once must not both read it free. `SHARE ROW EXCLUSIVE` conflicts with itself and with
   *  row writes, but not with the `FOR SHARE` row locks every sale takes. */
  async lockForOpening(tx: Tx): Promise<void> {
    await tx.execute(sql`lock table locations in share row exclusive mode`);
  },
  async insertOutlet(tx: Tx, row: typeof locations.$inferInsert): Promise<void> {
    await tx.insert(locations).values(row);
  },
  async updateLocation(tx: Tx, key: string, set: Partial<Pick<LocationRow, "name" | "code" | "floor" | "costCentre" | "priceList" | "active">>): Promise<void> {
    await tx.update(locations).set(set).where(eq(locations.key, key));
  },
  /** Everything a close waits on, counted under the close's own row lock. "Open" is `HOLDS_OUTLET`. */
  async closeBlockers(tx: Tx, key: string): Promise<OutletBlockers> {
    const n = (r: { n: number }[]) => Number(r[0]?.n ?? 0);
    const count = sql<number>`count(*)::int`;
    const stock = n(await tx.select({ n: count }).from(stockBalances).where(and(eq(stockBalances.loc, key), ne(stockBalances.onHand, 0))));
    const tkts = n(await tx.select({ n: count }).from(tickets).where(and(or(eq(tickets.fromLoc, key), eq(tickets.toLoc, key)), inArray(tickets.status, holding(HOLDS_OUTLET.ticket)))));
    const requests = n(await tx.select({ n: count }).from(stockRequests).where(and(eq(stockRequests.fromLoc, key), inArray(stockRequests.status, holding(HOLDS_OUTLET.request)))));
    const kitchenOrders = n(await tx.select({ n: count }).from(prodOrders).where(and(eq(prodOrders.fromLoc, key), inArray(prodOrders.status, holding(HOLDS_OUTLET.prodOrder)))));
    const asks = n(await tx.select({ n: count }).from(shopAsks).where(and(or(eq(shopAsks.fromLoc, key), eq(shopAsks.toLoc, key)), inArray(shopAsks.status, holding(HOLDS_OUTLET.shopAsk)))));
    const productReqs = n(await tx.select({ n: count }).from(productRequests).where(and(eq(productRequests.forLoc, key), inArray(productRequests.status, holding(HOLDS_OUTLET.productReq)))));
    const staff = await adminRepo.staffAt(tx, key);
    return { stock, tickets: tkts, requests, kitchenOrders, shopAsks: asks, productRequests: productReqs, staff };
  },
};
