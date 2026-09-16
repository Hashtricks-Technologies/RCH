// repo.ts: SQL only. No rules, no transaction of its own - service.ts opens the transaction
// and passes it in as `tx`.
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, or, sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AdminAction, PayerKind } from "@rch/contract";
import { AdminActionSchema, QUARANTINE } from "@rch/contract";
import { ACCOUNT_TENDERS, HOLDS_OUTLET, holding, type OutletBlockers } from "@rch/domain";
import type { Reader, Tx } from "../../lib/db.js";
import { adminActions, bills, locations, payers, prodOrders, productRequests, settlements, shopAsks, stockBalances, stockRequests, tickets, users } from "../../db/schema/index.js";

export type UserRow = typeof users.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;

/** The log is one table read three ways, and each tab's half of the closed union is read off the
 *  schema rather than typed out again - so an action added later is in its own filter the moment
 *  it is named. Matched by prefix and not by a `like 'outlet_%'` pattern: `_` is a
 *  single-character wildcard in `like`, and `_` is what every one of these names is spelled with.
 *  Accounts is what is left over, so a new account action needs no line here at all. */
const ACTIONS = AdminActionSchema.shape.action.options;
const OUTLET_ACTIONS: AdminAction["action"][] = ACTIONS.filter((a) => a.startsWith("outlet_"));
const PAYER_ACTIONS: AdminAction["action"][] = ACTIONS.filter((a) => a.startsWith("payer_"));
const NOT_ACCOUNT_ACTIONS: AdminAction["action"][] = [...OUTLET_ACTIONS, ...PAYER_ACTIONS];

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
  async recentActions(db: Reader, kind: "accounts" | "outlets" | "payers"): Promise<AdminAction[]> {
    const actor = alias(users, "actor");
    const target = alias(users, "target");
    const rows = await db.select({
      at: adminActions.at, action: adminActions.action, details: adminActions.details,
      actorName: actor.name, targetName: sql<string>`coalesce(${target.name}, ${adminActions.targetName})`,
    })
      .from(adminActions)
      .innerJoin(actor, eq(actor.id, adminActions.actorId))
      .leftJoin(target, eq(target.id, adminActions.targetId))
      .where(kind === "outlets" ? inArray(adminActions.action, OUTLET_ACTIONS)
        : kind === "payers" ? inArray(adminActions.action, PAYER_ACTIONS)
          : notInArray(adminActions.action, NOT_ACCOUNT_ACTIONS))
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
  async updateLocation(tx: Tx, key: string, set: Partial<Pick<LocationRow, "name" | "code" | "floor" | "costCentre" | "active">>): Promise<void> {
    await tx.update(locations).set(set).where(eq(locations.key, key));
  },
  /**
   * Everything a close waits on, in **one** statement, with the close's own `FOR UPDATE` row lock
   * already held. "Open" is `HOLDS_OUTLET`, whose status lists come in as this query's parameters.
   *
   * It has to stay one statement, and that is the whole point of the shape. `withTransaction` runs
   * at READ COMMITTED, where every statement takes its own snapshot, and several writes move an
   * outlet's commitment from one of these categories to another without ever naming the location -
   * `production.dispatch`, `shopasks.answer`, `tickets.receive` and `tickets.cancel` take no lock
   * on the row. Counted one statement at a time, a dispatch committing in between is seen by
   * neither count: the kitchen order no longer holds, and the ticket it raised was not there when
   * tickets were counted. A receive is the same story for stock. One snapshot leaves no gap to
   * commit in: a document that exists in it is counted, and one created after it either came from
   * a document that was counted or went through `lockLocation` and waited for this close.
   */
  async closeBlockers(tx: Tx, key: string): Promise<OutletBlockers> {
    const count = sql<number>`count(*)::int`;
    const of = (rows: SQLWrapper) => sql<number>`(${rows})`;
    // One row out - the outlet's own, which the caller has locked - carrying a scalar subquery per
    // blocker. The staff are folded in the same way rather than read separately: an account write
    // that could add one takes the location row `FOR SHARE` (`lib/users-admin.ts`), so it would be
    // serialised either way, and there is no second snapshot to reason about this way.
    const [b] = await tx.select({
      stock: of(tx.select({ n: count }).from(stockBalances).where(and(eq(stockBalances.loc, key), ne(stockBalances.onHand, 0)))),
      tickets: of(tx.select({ n: count }).from(tickets).where(and(or(eq(tickets.fromLoc, key), eq(tickets.toLoc, key)), inArray(tickets.status, holding(HOLDS_OUTLET.ticket))))),
      requests: of(tx.select({ n: count }).from(stockRequests).where(and(eq(stockRequests.fromLoc, key), inArray(stockRequests.status, holding(HOLDS_OUTLET.request))))),
      kitchenOrders: of(tx.select({ n: count }).from(prodOrders).where(and(eq(prodOrders.fromLoc, key), inArray(prodOrders.status, holding(HOLDS_OUTLET.prodOrder))))),
      shopAsks: of(tx.select({ n: count }).from(shopAsks).where(and(or(eq(shopAsks.fromLoc, key), eq(shopAsks.toLoc, key)), inArray(shopAsks.status, holding(HOLDS_OUTLET.shopAsk))))),
      productRequests: of(tx.select({ n: count }).from(productRequests).where(and(eq(productRequests.forLoc, key), inArray(productRequests.status, holding(HOLDS_OUTLET.productReq))))),
      staff: sql<string[]>`(select coalesce(array_agg(${users.empNo} order by ${users.empNo}), '{}') from ${users} where ${and(eq(users.loc, key), eq(users.active, true), eq(users.admin, false))})`,
    }).from(locations).where(eq(locations.key, key));
    return b;
  },

  // ---- the payer register --------------------------------------------------------------

  /** Every payer, active and inactive alike, with what they still owe and how many bills are
   *  behind it - the two numbers that make switching one off a decision rather than a click.
   *  Charged and settled are summed apart and subtracted here for the same reason
   *  `lib/credit.ts` does it: joining bills to settlements on the payer multiplies each bill by
   *  that payer's settlement count. */
  async payers(db: Reader): Promise<Array<{ kind: PayerKind; id: string; name: string; active: boolean; outstanding: number; bills: number }>> {
    const rows = await db.select().from(payers).orderBy(asc(payers.name), asc(payers.id));
    const charged = await db.select({
      kind: bills.payerKind, id: bills.payerId,
      total: sql<string>`coalesce(sum(${bills.total}), 0)`, n: sql<number>`count(*)::int`,
    }).from(bills)
      .where(and(inArray(bills.tender, [...ACCOUNT_TENDERS]), isNull(bills.voidedAt)))
      .groupBy(bills.payerKind, bills.payerId);
    const settled = await db.select({
      kind: settlements.kind, id: settlements.payerId, total: sql<string>`coalesce(sum(${settlements.amount}), 0)`,
    }).from(settlements).where(isNull(settlements.voidedAt)).groupBy(settlements.kind, settlements.payerId);

    const owed = new Map(charged.map((c) => [`${c.kind}:${c.id}`, { total: Number(c.total), n: c.n }]));
    const paid = new Map(settled.map((s) => [`${s.kind}:${s.id}`, Number(s.total)]));
    return rows.map((r) => {
      const c = owed.get(`${r.kind}:${r.id}`);
      const balance = (c?.total ?? 0) - (paid.get(`${r.kind}:${r.id}`) ?? 0);
      return {
        kind: r.kind, id: r.id, name: r.name, active: r.active,
        outstanding: Math.max(0, Math.round(balance * 100) / 100), bills: c?.n ?? 0,
      };
    });
  },
  /** Locked, so two admins renaming one payer queue rather than overwrite each other. */
  async payerForUpdate(tx: Tx, kind: PayerKind, id: string): Promise<typeof payers.$inferSelect | undefined> {
    const [p] = await tx.select().from(payers).where(and(eq(payers.kind, kind), eq(payers.id, id))).for("update");
    return p;
  },
  async insertPayer(tx: Tx, row: typeof payers.$inferInsert): Promise<void> {
    await tx.insert(payers).values(row);
  },
  async updatePayer(tx: Tx, kind: PayerKind, id: string, patch: { name?: string; active?: boolean }): Promise<void> {
    await tx.update(payers).set({ ...patch, updatedAt: new Date() }).where(and(eq(payers.kind, kind), eq(payers.id, id)));
  },
  /** What one payer owes right now, for the sentence a deactivation says. */
  async payerBalance(tx: Tx, kind: PayerKind, id: string): Promise<number> {
    const [c] = await tx.select({ total: sql<string>`coalesce(sum(${bills.total}), 0)` }).from(bills)
      .where(and(inArray(bills.tender, [...ACCOUNT_TENDERS]), eq(bills.payerKind, kind), eq(bills.payerId, id), isNull(bills.voidedAt)));
    const [s] = await tx.select({ total: sql<string>`coalesce(sum(${settlements.amount}), 0)` }).from(settlements)
      .where(and(eq(settlements.kind, kind), eq(settlements.payerId, id), isNull(settlements.voidedAt)));
    return Math.max(0, Math.round((Number(c?.total ?? 0) - Number(s?.total ?? 0)) * 100) / 100);
  },
};
