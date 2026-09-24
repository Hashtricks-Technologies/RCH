// Qr: the worker's jobs - expire unpaid orders past their window, reconcile what the gateway knows
// and RCH was never told, and send the refunds the captures and voids queued. `plugins/qr-worker.ts`
// runs `tick` on an interval (and when nudged); the tests call it directly. Nothing here holds a
// lock across a gateway call: the claim commits first, the send happens with no transaction open,
// and the answer is written in a fresh one.
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
import type { createQrService } from "./service.js";

/** How many of each a pass takes: enough for a busy hour, small enough that one pass never holds
 *  a transaction long. Whatever is left is the next pass's. */
const EXPIRE_BATCH = 200;
const REFUND_BATCH = 20;

/**
 * The reconcile pass - the backstop for a payment whose verify and webhook both went missing (the
 * phone's tab closed, a delivery Razorpay gave up on), and for a refund whose final webhook never
 * came. It runs at most every `RECONCILE_EVERY_MS` and asks about at most `RECONCILE_BATCH` orders
 * and as many refunds a pass; each thing asked about is asked again only after half its age has
 * passed again (never sooner than the pass interval), so an abandoned cart is asked about a dozen
 * times over its two days, not every pass.
 */
const RECONCILE_EVERY_MS = 2 * 60_000;
const RECONCILE_BATCH = 20;
/** An order younger than this is the phone's own business still (its verify may be in flight). */
const RECONCILE_MIN_AGE_MS = 2 * 60_000;
/** An order older than this is past asking: an authorised payment is long released by then. */
const RECONCILE_MAX_AGE_MS = 48 * 60 * 60_000;
/** A Sent refund older than this without its webhook is asked about directly. */
const REFUND_POLL_AFTER_MS = 30 * 60_000;

export type TickResult = { expired: number; reconciled: number; polled: number; sent: number; deferred: number; failed: number };
/** `reconcile`: true runs the reconcile pass now, false skips it, and left out it runs when
 *  `RECONCILE_EVERY_MS` has passed since the last one. */
export type TickOptions = { reconcile?: boolean };

type Settler = Pick<ReturnType<typeof createQrService>, "settlePayment" | "settleRefund">;

export function createQrWorker(db: Db, gateway: () => PaymentGateway | null, log: FastifyBaseLogger, settler: Settler) {
  /** When each order (`o:`) or refund (`r:`) may next be asked about, in this process. Lost on a
   *  restart, which only means asking once more; two pods asking twice settle once. */
  const nextAsk = new Map<string, number>();
  let lastReconcile = 0;
  const via = { method: "", path: "" };

  /** Which of `rows` are due to be asked about at `now`, at most `RECONCILE_BATCH`, with each
   *  one's next time set; entries for rows no longer candidates are forgotten. */
  function due<T extends { id: string }>(prefix: string, rows: T[], bornAt: (r: T) => Date, now: Date): T[] {
    const t = now.getTime();
    const live = new Set(rows.map((r) => prefix + r.id));
    for (const k of nextAsk.keys()) if (k.startsWith(prefix) && !live.has(k)) nextAsk.delete(k);
    const out = rows.filter((r) => (nextAsk.get(prefix + r.id) ?? 0) <= t).slice(0, RECONCILE_BATCH);
    for (const r of out) nextAsk.set(prefix + r.id, t + Math.max(RECONCILE_EVERY_MS, (t - bornAt(r).getTime()) / 2));
    return out;
  }

  /** Orders the gateway may hold a payment for: each order's payments are asked for, an
   *  authorised one is captured and a captured one settled - billed, or refunded - exactly as the
   *  webhook would have. A gateway that cannot be asked, or a Z closing the register, leaves the
   *  order for a later pass. */
  async function reconcileOrders(now: Date): Promise<number> {
    const gw = gateway();
    if (!gw) return 0;
    const rows = await qrRepo.toReconcile(db, new Date(now.getTime() - RECONCILE_MAX_AGE_MS), new Date(now.getTime() - RECONCILE_MIN_AGE_MS));
    let settled = 0;
    for (const o of due("o:", rows, (r) => r.createdAt, now)) {
      try {
        for (const p of await gw.paymentsOfOrder(o.rzpOrderId!)) {
          if (p.status !== "captured" && p.status !== "authorized") continue;
          if (await settler.settlePayment(o, p, via)) settled += 1;
        }
      } catch (err) {
        log.warn({ err, order: o.id }, "qr reconcile could not settle an order - it is asked about again later");
      }
    }
    return settled;
  }

  /** Refunds Sent a while ago and never reported back: the gateway is asked, and a processed or
   *  failed one is recorded as its webhook would have. */
  async function pollRefunds(now: Date): Promise<number> {
    const gw = gateway();
    if (!gw) return 0;
    const rows = await qrRepo.sentRefunds(db, new Date(now.getTime() - REFUND_POLL_AFTER_MS));
    let settled = 0;
    for (const r of due("r:", rows, (x) => x.updatedAt, now)) {
      try {
        const g = await gw.fetchRefund(r.paymentId, r.rzpRefundId!);
        if (g.status !== "processed" && g.status !== "failed") continue;
        if (await settler.settleRefund(g.id, r.id, g.status, via)) settled += 1;
      } catch (err) {
        log.warn({ err, refund: r.id }, "qr reconcile could not read a refund - it is asked about again later");
      }
    }
    return settled;
  }
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
  async function sendRefunds(now: Date): Promise<Pick<TickResult, "sent" | "deferred" | "failed">> {
    const out = { sent: 0, deferred: 0, failed: 0 };
    const gw = gateway();
    if (!gw) return out;
    const claimed = await withTransaction(db, (tx) => claimDueRefunds(tx, now, REFUND_BATCH));
    for (const r of claimed) out[await sendOne(gw, r)] += 1;
    return out;
  }

  return {
    /** Expire, reconcile (when due), then send - so a refund the reconcile queued goes out in the
     *  same pass. */
    async tick(now = new Date(), opts: TickOptions = {}): Promise<TickResult> {
      const expired = await expire(now);
      let reconciled = 0;
      let polled = 0;
      if (opts.reconcile ?? Date.now() - lastReconcile >= RECONCILE_EVERY_MS) {
        lastReconcile = Date.now();
        reconciled = await reconcileOrders(now);
        polled = await pollRefunds(now);
      }
      return { expired, reconciled, polled, ...(await sendRefunds(now)) };
    },
  };
}
