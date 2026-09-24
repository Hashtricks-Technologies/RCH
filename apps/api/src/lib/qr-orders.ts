import { eq } from "drizzle-orm";
import type { QrOrderStatus } from "@rch/contract";
import { QR_ORDER_TRANSITIONS } from "@rch/domain";
import { qrOrders } from "../db/schema/index.js";
import type { Tx } from "./db.js";
import { appendHistory } from "./history.js";
import { assertTransition } from "./rules.js";

/**
 * A QR order's row, locked, and its one way to change status. Two modules move an order: `qr`
 * (the capture, the counter's steps, the worker's expiry) and `pos` (a void of the bill behind
 * it), so the lock and the move live here rather than in either module's repo - a second copy of
 * the move would be a second chance to skip the transition table or the trail.
 *
 * Where it sits in the lock order: a capture takes the order first (then the outlet, the session,
 * the shelves and the bill number, through `postSale`); a void takes the bill, then the order,
 * then the outlet. Both take the order in the documents tier, ahead of every id and balance.
 */
export type QrOrderRow = typeof qrOrders.$inferSelect;

/** The order, `FOR UPDATE`, or undefined when there is no such order. */
export async function qrOrderForUpdate(tx: Tx, id: string): Promise<QrOrderRow | undefined> {
  const [row] = await tx.select().from(qrOrders).where(eq(qrOrders.id, id)).for("update");
  return row;
}

/**
 * Move a locked order along `QR_ORDER_TRANSITIONS`, refusing any other move in words, with its
 * trail line. `patch` carries what the move settles besides the status (the payment and bill a
 * capture made, when it was paid). `note` finishes the trail line ("Refunded - sold out").
 */
export async function moveQrOrder(tx: Tx, row: Pick<QrOrderRow, "id" | "status">, to: QrOrderStatus, who: string, opts: {
  at?: Date; note?: string; patch?: Partial<Pick<QrOrderRow, "rzpPaymentId" | "billNo" | "paidAt">>;
} = {}): Promise<QrOrderRow> {
  assertTransition(QR_ORDER_TRANSITIONS, row.status, to, row.id);
  const at = opts.at ?? new Date();
  const [next] = await tx.update(qrOrders).set({ status: to, updatedAt: at, ...opts.patch }).where(eq(qrOrders.id, row.id)).returning();
  await appendHistory(tx, "qr_order", row.id, opts.note ? `${to} - ${opts.note}` : to, who, at);
  return next;
}
