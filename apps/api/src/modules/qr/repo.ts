// Qr: SQL only. No rules, no transaction of its own - service.ts and worker.ts pass `tx` in. The
// order's lock and its status move are `lib/qr-orders.ts` (the bill void moves an order too), and
// every write of `payment_refunds` is `lib/refunds.ts`; this file only reads refunds.
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { OrderHours, OrderHoursDay, QrOrderStatus } from "@rch/contract";
import { documentHistory, items, locations, paymentRefunds, qrCodes, qrOrderLines, qrOrders, qrOutletState, outletOrderHours, rzpWebhookEvents, users } from "../../db/schema/index.js";
import type { Reader, Tx } from "../../lib/db.js";
import type { HistEntry } from "../../lib/history.js";
import type { QrOrderRow } from "../../lib/qr-orders.js";
import type { RefundRow } from "../../lib/refunds.js";
import { iso } from "../../lib/time.js";

export type QrCodeRow = typeof qrCodes.$inferSelect;
export type QrLineRow = typeof qrOrderLines.$inferSelect & { name: string };

const byDow = (a: OrderHoursDay, b: OrderHoursDay) => a.dow - b.dow;

export const qrRepo = {
  // ---- codes

  /** A code by the token a poster encodes, active or not - the caller decides what inactive means. */
  async codeByToken(db: Reader, token: string): Promise<QrCodeRow | undefined> {
    const [c] = await db.select().from(qrCodes).where(eq(qrCodes.token, token));
    return c;
  },
  /** The same, `FOR SHARE`: placing an order holds the code so a deactivation or a regenerate in
   *  the same instant either lands first (and the order is refused) or waits for it. */
  async codeByTokenForShare(tx: Tx, token: string): Promise<QrCodeRow | undefined> {
    const [c] = await tx.select().from(qrCodes).where(eq(qrCodes.token, token)).for("share");
    return c;
  },
  async codeForUpdate(tx: Tx, id: string): Promise<QrCodeRow | undefined> {
    const [c] = await tx.select().from(qrCodes).where(eq(qrCodes.id, id)).for("update");
    return c;
  },
  async codes(db: Reader): Promise<QrCodeRow[]> {
    return db.select().from(qrCodes).orderBy(asc(qrCodes.loc), asc(qrCodes.id));
  },
  async insertCode(tx: Tx, row: typeof qrCodes.$inferInsert): Promise<QrCodeRow> {
    const [c] = await tx.insert(qrCodes).values(row).returning();
    return c;
  },
  async updateCode(tx: Tx, id: string, patch: Partial<Pick<QrCodeRow, "label" | "mode" | "active" | "token" | "rotatedAt">>): Promise<QrCodeRow> {
    const [c] = await tx.update(qrCodes).set(patch).where(eq(qrCodes.id, id)).returning();
    return c;
  },

  // ---- hours and the pause switch

  async hoursOf(db: Reader, loc: string): Promise<OrderHoursDay[]> {
    const rows = await db.select().from(outletOrderHours).where(eq(outletOrderHours.loc, loc));
    return rows.map((r) => ({ dow: r.dow, opens: r.opens, closes: r.closes })).sort(byDow);
  },
  /** Every outlet's week, or only the named ones. An outlet with no rows is listed with no days,
   *  so the editor and the queue draw every outlet they were asked about. */
  async hours(db: Reader, locs: string[]): Promise<OrderHours[]> {
    if (locs.length === 0) return [];
    const rows = await db.select().from(outletOrderHours).where(inArray(outletOrderHours.loc, locs));
    return locs.map((loc) => ({ loc, days: rows.filter((r) => r.loc === loc).map((r) => ({ dow: r.dow, opens: r.opens, closes: r.closes })).sort(byDow) }));
  },
  async replaceHours(tx: Tx, loc: string, days: OrderHoursDay[]): Promise<void> {
    await tx.delete(outletOrderHours).where(eq(outletOrderHours.loc, loc));
    if (days.length > 0) await tx.insert(outletOrderHours).values(days.map((d) => ({ loc, dow: d.dow, opens: d.opens, closes: d.closes })));
  },
  async paused(db: Reader, locs: string[]): Promise<Record<string, boolean>> {
    if (locs.length === 0) return {};
    const rows = await db.select().from(qrOutletState).where(inArray(qrOutletState.loc, locs));
    return Object.fromEntries(locs.map((l) => [l, rows.find((r) => r.loc === l)?.paused ?? false]));
  },
  async pausedForUpdate(tx: Tx, loc: string): Promise<boolean> {
    const [r] = await tx.select().from(qrOutletState).where(eq(qrOutletState.loc, loc)).for("update");
    return r?.paused ?? false;
  },
  async setPaused(tx: Tx, loc: string, paused: boolean, by: string, at: Date): Promise<void> {
    await tx.insert(qrOutletState).values({ loc, paused, updatedAt: at, updatedBy: by })
      .onConflictDoUpdate({ target: qrOutletState.loc, set: { paused, updatedAt: at, updatedBy: by } });
  },

  // ---- outlets and people

  async userName(db: Reader, id: string): Promise<string> {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, id));
    return u?.name ?? id;
  },

  async outletKeys(db: Reader): Promise<string[]> {
    return (await db.select({ key: locations.key }).from(locations).where(eq(locations.type, "Outlet")).orderBy(asc(locations.key))).map((r) => r.key);
  },
  async location(db: Reader, key: string): Promise<typeof locations.$inferSelect | undefined> {
    const [l] = await db.select().from(locations).where(eq(locations.key, key));
    return l;
  },

  // ---- placing an order

  /** The caps are counted under an advisory lock on the phone and one on the address, taken in a
   *  fixed order, so two orders racing from one phone cannot both read "two pending". */
  async lockCaps(tx: Tx, phone: string, ip: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`qr-phone:${phone}`}))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`qr-ip:${ip}`}))`);
  },
  /** Unpaid orders this phone has open at this outlet - still inside their window. */
  async pendingForPhone(tx: Tx, loc: string, phone: string, now: Date): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(qrOrders)
      .where(and(eq(qrOrders.loc, loc), eq(qrOrders.customerPhone, phone), eq(qrOrders.status, "Awaiting payment"), gt(qrOrders.expiresAt, now)));
    return r.n;
  },
  /** Unpaid orders placed from this address since `since`, at any outlet. */
  async pendingForIp(tx: Tx, ip: string, since: Date): Promise<number> {
    const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(qrOrders)
      .where(and(eq(qrOrders.ip, ip), eq(qrOrders.status, "Awaiting payment"), gte(qrOrders.createdAt, since)));
    return r.n;
  },
  async orderByNonce(db: Reader, nonceHash: string): Promise<QrOrderRow | undefined> {
    const [o] = await db.select().from(qrOrders).where(eq(qrOrders.nonce, nonceHash));
    return o;
  },
  async insertOrder(tx: Tx, row: typeof qrOrders.$inferInsert, lines: { it: string; qty: number; rate: number }[]): Promise<QrOrderRow> {
    const [o] = await tx.insert(qrOrders).values(row).returning();
    await tx.insert(qrOrderLines).values(lines.map((l, lineNo) => ({ orderId: o.id, lineNo, itemKey: l.it, qty: l.qty, rate: l.rate })));
    return o;
  },
  async setSecret(tx: Tx, id: string, secretHash: string, at: Date): Promise<void> {
    await tx.update(qrOrders).set({ secretHash, updatedAt: at }).where(eq(qrOrders.id, id));
  },
  /** The gateway's order, stored once: a second request that created one too loses, and reads
   *  the first one's back. */
  async setRzpOrder(tx: Tx, id: string, rzpOrderId: string): Promise<string | null> {
    await tx.update(qrOrders).set({ rzpOrderId }).where(and(eq(qrOrders.id, id), isNull(qrOrders.rzpOrderId)));
    const [o] = await tx.select({ rzp: qrOrders.rzpOrderId }).from(qrOrders).where(eq(qrOrders.id, id));
    return o?.rzp ?? null;
  },

  // ---- reading orders

  async order(db: Reader, id: string): Promise<QrOrderRow | undefined> {
    const [o] = await db.select().from(qrOrders).where(eq(qrOrders.id, id));
    return o;
  },
  async orderByRzpOrder(db: Reader, rzpOrderId: string): Promise<QrOrderRow | undefined> {
    const [o] = await db.select().from(qrOrders).where(eq(qrOrders.rzpOrderId, rzpOrderId));
    return o;
  },
  /** Lines with the item's name, in the order they were placed. */
  async lines(db: Reader, ids: string[]): Promise<Map<string, QrLineRow[]>> {
    const m = new Map<string, QrLineRow[]>();
    if (ids.length === 0) return m;
    const rows = await db.select({ l: qrOrderLines, name: items.name }).from(qrOrderLines)
      .innerJoin(items, eq(items.key, qrOrderLines.itemKey))
      .where(inArray(qrOrderLines.orderId, ids)).orderBy(asc(qrOrderLines.orderId), asc(qrOrderLines.lineNo));
    for (const r of rows) (m.get(r.l.orderId) ?? m.set(r.l.orderId, []).get(r.l.orderId)!).push({ ...r.l, name: r.name });
    return m;
  },
  /** Every refund behind these orders, oldest first. */
  async refunds(db: Reader, ids: string[]): Promise<Map<string, RefundRow[]>> {
    const m = new Map<string, RefundRow[]>();
    if (ids.length === 0) return m;
    const rows = await db.select().from(paymentRefunds).where(inArray(paymentRefunds.qrOrderId, ids))
      .orderBy(asc(paymentRefunds.createdAt), asc(paymentRefunds.id));
    for (const r of rows) (m.get(r.qrOrderId) ?? m.set(r.qrOrderId, []).get(r.qrOrderId)!).push(r);
    return m;
  },
  async histories(db: Reader, ids: string[]): Promise<Map<string, HistEntry[]>> {
    const m = new Map<string, HistEntry[]>();
    if (ids.length === 0) return m;
    const rows = await db.select().from(documentHistory)
      .where(and(eq(documentHistory.docType, "qr_order"), inArray(documentHistory.docId, ids)))
      .orderBy(asc(documentHistory.at), asc(documentHistory.id));
    for (const r of rows) (m.get(r.docId) ?? m.set(r.docId, []).get(r.docId)!).push({ s: r.status, who: r.who, t: iso(r.at) });
    return m;
  },
  /** The counter's queue at these outlets: everything paid and not yet handed over, whenever it
   *  was placed, and everything finished since `since` (the IST day's start). An order still
   *  awaiting payment, or one that expired unpaid, is the customer's business, not the counter's. */
  async queue(db: Reader, locs: string[], live: QrOrderStatus[], done: QrOrderStatus[], since: Date): Promise<QrOrderRow[]> {
    if (locs.length === 0) return [];
    return db.select().from(qrOrders)
      .where(and(inArray(qrOrders.loc, locs), or(inArray(qrOrders.status, live), and(inArray(qrOrders.status, done), gte(qrOrders.updatedAt, since)))))
      .orderBy(desc(qrOrders.createdAt), desc(qrOrders.id));
  },

  // ---- the worker

  /** Unpaid orders past their window, taken `for update skip locked` so two pods never expire
   *  the same one and a capture holding an order is simply passed over this time. */
  async dueToExpire(tx: Tx, now: Date, limit: number): Promise<QrOrderRow[]> {
    return tx.select().from(qrOrders)
      .where(and(eq(qrOrders.status, "Awaiting payment"), lte(qrOrders.expiresAt, now)))
      .orderBy(asc(qrOrders.expiresAt), asc(qrOrders.id)).limit(limit)
      .for("update", { skipLocked: true });
  },

  // ---- refunds, read

  async refundForUpdate(tx: Tx, id: string): Promise<RefundRow | undefined> {
    const [r] = await tx.select().from(paymentRefunds).where(eq(paymentRefunds.id, id)).for("update");
    return r;
  },
  /** A refund the gateway names: by its own refund id once we have it, else by the `notes.rid`
   *  the worker wrote into it (a webhook can beat the worker's own record of the send). */
  async refundForGateway(tx: Tx, rzpRefundId: string, rid: string | undefined): Promise<RefundRow | undefined> {
    const [r] = await tx.select().from(paymentRefunds)
      .where(rid ? or(eq(paymentRefunds.rzpRefundId, rzpRefundId), eq(paymentRefunds.id, rid)) : eq(paymentRefunds.rzpRefundId, rzpRefundId))
      .for("update");
    return r;
  },
  async refundOfPayment(tx: Tx, orderId: string, paymentId: string): Promise<RefundRow | undefined> {
    const [r] = await tx.select().from(paymentRefunds).where(and(eq(paymentRefunds.qrOrderId, orderId), eq(paymentRefunds.paymentId, paymentId)));
    return r;
  },

  // ---- webhook deliveries

  async webhookSeen(db: Reader, eventId: string): Promise<boolean> {
    const [r] = await db.select({ id: rzpWebhookEvents.eventId }).from(rzpWebhookEvents).where(eq(rzpWebhookEvents.eventId, eventId));
    return !!r;
  },
  async markWebhook(tx: Tx, eventId: string, event: string): Promise<void> {
    await tx.insert(rzpWebhookEvents).values({ eventId, event }).onConflictDoNothing();
  },
};
