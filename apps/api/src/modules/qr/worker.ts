// Qr: the worker's two jobs - expire unpaid orders past their window, and send the refunds the
// captures and voids queued. `plugins/qr-worker.ts` runs `tick` on an interval (and when nudged);
// the tests call it directly. Nothing here holds a lock across a gateway call: the claim commits
// first, the send happens with no transaction open, and the answer is written in a fresh one.
import type { FastifyBaseLogger } from "fastify";
import { money as inr, paise } from "@rch/domain";
import type { Db } from "../../db/client.js";
import { recordSystemEvent } from "../../lib/audit.js";
import { withTransaction } from "../../lib/db.js";
import { emitChanged } from "../../lib/events.js";
import { GatewayError, type GatewayRefund, type PaymentGateway } from "../../lib/payments.js";
import { moveQrOrder } from "../../lib/qr-orders.js";
import { claimDueRefunds, deferRefund, moveRefund, type RefundRow } from "../../lib/refunds.js";
import { SYSTEM_QR } from "../../lib/system-users.js";
import { qrRepo } from "./repo.js";

/** How many of each a pass takes: enough for a busy hour, small enough that one pass never holds
 *  a transaction long. Whatever is left is the next pass's. */
const EXPIRE_BATCH = 200;
const REFUND_BATCH = 20;

export type TickResult = { expired: number; sent: number; deferred: number; failed: number };

export function createQrWorker(db: Db, gateway: () => PaymentGateway | null, log: FastifyBaseLogger) {
  /** Unpaid orders past `expires_at` become Expired. A capture that arrives later still settles
   *  (`Expired -> Paid | Refunded`). The counter never saw them, so nothing is announced. */
  async function expire(now: Date): Promise<number> {
    return withTransaction(db, async (tx) => {
      const due = await qrRepo.dueToExpire(tx, now, EXPIRE_BATCH);
      for (const o of due) await moveQrOrder(tx, o, "Expired", SYSTEM_QR.name, { at: now });
      return due.length;
    });
  }

  /** Where a refund's order is, for its audit event. */
  const locOf = async (r: RefundRow) => (await qrRepo.order(db, r.qrOrderId))?.loc;

  /**
   * Send one claimed refund. First ask the gateway for the refunds already on the payment and
   * look for this one's `notes.rid`: a send whose answer was lost (a timeout, a pod that died)
   * did reach the gateway, and sending again would refund twice. Then record what came of it -
   * unless a webhook has recorded it already, which the fresh lock finds.
   */
  async function sendOne(gw: PaymentGateway, r: RefundRow): Promise<"sent" | "deferred" | "failed"> {
    let g: GatewayRefund;
    try {
      const prior = (await gw.refundsOf(r.paymentId)).find((x) => x.notes.rid === r.id && x.status !== "failed");
      g = prior ?? await gw.refund(r.paymentId, { amountPaise: paise(r.amount), receipt: r.id, notes: { rid: r.id, qr_order: r.qrOrderId } });
    } catch (e) {
      const ge = e instanceof GatewayError ? e : null;
      if (!ge) log.error({ err: e, refund: r.id }, "refund send failed unexpectedly");
      const loc = await locOf(r);
      return withTransaction(db, async (tx) => {
        const cur = await qrRepo.refundForUpdate(tx, r.id);
        if (!cur || cur.status !== "Pending") return "sent" as const;
        const next = await deferRefund(tx, r.id, { error: ge?.message ?? "The refund could not be sent", final: ge ? !ge.retryable : false, counted: true });
        if (next.status !== "Failed") return "deferred" as const;
        await recordSystemEvent(tx, {
          action: "qrRefundFailed", subject: r.id, loc,
          message: `Refund ${r.id} of ${inr(r.amount)} failed after ${next.attempts} attempt${next.attempts === 1 ? "" : "s"} - ${next.lastError}`,
          result: { refund: r.id, attempts: next.attempts, error: next.lastError },
        });
        await emitChanged(tx, ["qrOrders", "bills"]);
        return "failed" as const;
      });
    }
    const loc = await locOf(r);
    await withTransaction(db, async (tx) => {
      const cur = await qrRepo.refundForUpdate(tx, r.id);
      if (!cur || cur.status !== "Pending") return;
      await moveRefund(tx, r.id, "Sent", { rzpRefundId: g.id });
      await recordSystemEvent(tx, {
        action: "qrRefundSent", subject: r.id, loc, message: `Refund ${r.id} of ${inr(r.amount)} sent to the payment gateway (${g.id})`,
        result: { refund: r.id, rzpRefundId: g.id, status: g.status },
      });
      // A test key often settles a refund on the spot; a live one reports it by webhook later.
      if (g.status === "processed") {
        await moveRefund(tx, r.id, "Processed", { rzpRefundId: g.id });
        await recordSystemEvent(tx, { action: "qrRefundProcessed", subject: r.id, loc, message: `Refund ${r.id} of ${inr(r.amount)} reached the customer`, result: { refund: r.id, rzpRefundId: g.id } });
      } else if (g.status === "failed") {
        await moveRefund(tx, r.id, "Failed", { rzpRefundId: g.id, error: "The payment gateway reported that the refund failed" });
        await recordSystemEvent(tx, { action: "qrRefundFailed", subject: r.id, loc, message: `Refund ${r.id} of ${inr(r.amount)} failed at the payment gateway - a manager can retry it`, result: { refund: r.id, rzpRefundId: g.id } });
      }
      await emitChanged(tx, ["qrOrders", "bills"]);
    });
    return "sent";
  }

  /** The due Pending refunds, claimed (attempt counted, next attempt put off) and committed before
   *  any is sent. With no gateway configured they wait where they are. */
  async function sendRefunds(now: Date): Promise<Omit<TickResult, "expired">> {
    const out = { sent: 0, deferred: 0, failed: 0 };
    const gw = gateway();
    if (!gw) return out;
    const claimed = await withTransaction(db, (tx) => claimDueRefunds(tx, now, REFUND_BATCH));
    for (const r of claimed) out[await sendOne(gw, r)] += 1;
    return out;
  }

  return {
    async tick(now = new Date()): Promise<TickResult> {
      const expired = await expire(now);
      return { expired, ...(await sendRefunds(now)) };
    },
  };
}
