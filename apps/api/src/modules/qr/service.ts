// Qr: the flow - a customer's order from a printed code to a bill at the outlet, the counter's
// queue, and the super admin's codes and hours. Composes lib/sale.ts (the bill itself),
// lib/qr-orders.ts (an order's lock and status move), lib/refunds.ts (money going back) and
// lib/payments.ts (the gateway, never called inside a transaction).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  routes, type AdminQrCode, type AdminQrCodesResponse, type Bill, type Changed, type CreateQrCodeBody, type CreateQrOrderBody,
  type OrderHours, type OrderHoursDay, type PublicMenu, type PublicQrOrder, type QrOrder, type QrOrderCreated, type QrOrderStatus,
  type QrOrdersResponse, type QrRefund, type UpdateQrCodeBody, type VerifyQrPaymentBody, type WriteResponse,
} from "@rch/contract";
import {
  customerPhoneRefusal, hoursRefusal, istDate, money as inr, nextQrStep, normalizePhone, paise, pausedRefusal, planBill,
  QR_MAX_QTY, QR_PENDING_PER_IP, QR_PENDING_PER_PHONE, qrOpenAt, qrStepsFor,
} from "@rch/domain";
import type { Db } from "../../db/client.js";
import { auditBefore, recordSystemEvent } from "../../lib/audit.js";
import { isUniqueViolation, withReadTransaction, withTransaction, type Reader, type Tx } from "../../lib/db.js";
import { AppError, ConflictError, NotFoundError, NotReadyError, RateLimitedError, RuleError, UnauthenticatedError, ValidationError } from "../../lib/errors.js";
import { emitChanged } from "../../lib/events.js";
import { appendHistory } from "../../lib/history.js";
import { allocateId } from "../../lib/ids.js";
import { lockLocation } from "../../lib/locations.js";
import { GatewayError, type GatewayPayment, type PaymentGateway } from "../../lib/payments.js";
import { moveQrOrder, qrOrderForUpdate, type QrOrderRow } from "../../lib/qr-orders.js";
import { moveRefund, queueRefund, toWireRefund, type RefundRow } from "../../lib/refunds.js";
import { assertRule } from "../../lib/rules.js";
import { assertSellable, cartOf, menuOf, postSale, sellableAt } from "../../lib/sale.js";
import { SYSTEM_QR, systemOperator } from "../../lib/system-users.js";
import { termsFor } from "../../lib/terms.js";
import { dateAt, iso } from "../../lib/time.js";
import type { LocationRow } from "../../lib/wire.js";
import { requireLocOf, type Actor } from "../../plugins/rbac.js";
import { qrRepo, type QrCodeRow, type QrLineRow } from "./repo.js";

type QrPauseResult = { loc: string; paused: boolean };

/** Who asked, for the system's own audit events: a public route has no caller to name. */
export type RequestMeta = { requestId: string; ip: string; device: string };

// ---- the sentences a customer reads

/** An unknown, switched-off or regenerated code - one sentence, however it is asked, so a
 *  stranger cannot tell a code that never existed from one that was withdrawn. */
export const CODE_GONE = "This QR code is no longer in use - please order at the counter.";
export const NOT_SET_UP = "Online ordering is not set up yet - order at the counter.";
/** An order id with the wrong secret reads exactly like one that does not exist. */
const ORDER_GONE = "There is no such order.";
const GATEWAY_DOWN = "We could not reach the payment service - please try again in a moment.";
const VERIFY_LATER = "We could not confirm your payment yet - this page will update as soon as it goes through.";

/** The window the per-address cap counts unpaid orders over. */
const IP_WINDOW_MS = 30 * 60_000;
const money2 = (n: number): number => Math.round(n * 100) / 100;
const sha256 = (v: string): string => createHash("sha256").update(v).digest("hex");
/** A fresh token for a printed code: 192 random bits. */
const newToken = (): string => randomBytes(24).toString("base64url");

/** Whether `given` is the secret whose sha256 is stored - both digests compared in constant time. */
function secretMatches(storedHash: string, given: string): boolean {
  const a = Buffer.from(sha256(given), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The refund a reader shows for an order: the newest one that is not a second payment's, else
 *  the newest of all - a customer who paid twice still sees their money going back. */
function refundShown(rs: RefundRow[] | undefined): RefundRow | null {
  if (!rs || rs.length === 0) return null;
  return [...rs].reverse().find((r) => r.reason !== "duplicate") ?? rs[rs.length - 1];
}

const LIVE: QrOrderStatus[] = ["Paid", "Preparing", "Ready", "Out for delivery"];
const DONE: QrOrderStatus[] = ["Collected", "Delivered", "Refunded", "Voided"];

const wireLines = (ls: QrLineRow[] | undefined) =>
  (ls ?? []).map((l) => ({ it: l.itemKey, name: l.name, qty: l.qty, rate: l.rate, amount: money2(l.qty * l.rate) }));

function toPublicOrder(o: QrOrderRow, lines: QrLineRow[] | undefined, refunds: RefundRow[] | undefined, outletName: string): PublicQrOrder {
  const r = refundShown(refunds);
  return {
    id: o.id, loc: o.loc, outletName, label: o.label, mode: o.mode, spot: o.spot, status: o.status,
    lines: wireLines(lines), total: o.total, tax: o.tax, discount: o.discount, at: iso(o.createdAt),
    ...(o.paidAt ? { paidAt: iso(o.paidAt) } : {}), ...(o.billNo ? { billNo: o.billNo } : {}),
    refund: r ? { status: r.status, amount: r.amount } : null,
    steps: qrStepsFor(o.mode),
  };
}

function toStaffOrder(o: QrOrderRow, lines: QrLineRow[] | undefined, refunds: RefundRow[] | undefined, hist?: { s: string; who: string; t: string }[]): QrOrder {
  const r = refundShown(refunds);
  return {
    id: o.id, loc: o.loc, label: o.label, mode: o.mode, spot: o.spot, status: o.status,
    name: o.customerName, phone: o.customerPhone,
    lines: wireLines(lines), total: o.total, tax: o.tax, discount: o.discount, at: iso(o.createdAt),
    ...(o.paidAt ? { paidAt: iso(o.paidAt) } : {}), ...(o.billNo ? { billNo: o.billNo } : {}),
    refund: r ? toWireRefund(r) : null,
    ...(hist ? { hist } : {}),
  };
}

const toAdminCode = (c: QrCodeRow): AdminQrCode => ({
  id: c.id, loc: c.loc, label: c.label, mode: c.mode, token: c.token, active: c.active,
  createdAt: iso(c.createdAt), ...(c.rotatedAt ? { rotatedAt: iso(c.rotatedAt) } : {}),
});

/** A location a QR write names: it must exist and be an outlet. Held `FOR SHARE` (`lockLocation`),
 *  in the documents tier, so the admin's close waits for the write or the write reads it closed. */
async function lockOutlet(tx: Tx, key: string): Promise<LocationRow> {
  const row = await lockLocation(tx, key).catch((e: unknown) => {
    if (e instanceof NotFoundError) throw new NotFoundError(`There is no outlet ${key}.`);
    throw e;
  });
  if (row.type !== "Outlet") throw new NotFoundError(`There is no outlet ${key}.`);
  return row;
}

/** One order as the customer's page reads it, from any reader. */
async function publicOrderOf(db: Reader, o: QrOrderRow): Promise<PublicQrOrder> {
  const lines = (await qrRepo.lines(db, [o.id])).get(o.id);
  const refunds = (await qrRepo.refunds(db, [o.id])).get(o.id);
  const loc = await qrRepo.location(db, o.loc);
  return toPublicOrder(o, lines, refunds, loc?.name ?? o.loc);
}

/** What a capture decided, for the verify's answer and the webhook's log. */
type Settled = { order: QrOrderRow; changed: Changed[]; message: string; refundQueued: boolean };

export type QrServiceDeps = {
  db: Db;
  /** Read per call, not once: a test swaps the gateway, and `null` means QR ordering is off. */
  gateway: () => PaymentGateway | null;
  config: { maxRupees: number; ttlMin: number };
  /** Wake the worker after a commit that queued a refund. */
  nudge: () => void;
};

export function createQrService({ db, gateway, config, nudge }: QrServiceDeps) {
  const gatewayOrOff = (): PaymentGateway => {
    const gw = gateway();
    if (!gw) throw new NotReadyError(NOT_SET_UP);
    return gw;
  };

  /** The gateway's order for one of ours, created the first time it is needed - after the order's
   *  own transaction has committed, never inside it - and stored once. */
  async function checkoutFor(o: QrOrderRow, gw: PaymentGateway): Promise<QrOrderCreated["checkout"]> {
    let rzp = o.rzpOrderId;
    if (!rzp) {
      let made;
      try {
        made = await gw.createOrder({ amountPaise: paise(o.total), receipt: o.id, notes: { qr_order: o.id, loc: o.loc } });
      } catch (e) {
        if (e instanceof GatewayError) throw new NotReadyError(GATEWAY_DOWN, e);
        throw e;
      }
      rzp = await withTransaction(db, (tx) => qrRepo.setRzpOrder(tx, o.id, made.id)) ?? made.id;
    }
    return { keyId: gw.keyId, orderId: rzp, amount: paise(o.total), currency: "INR", prefill: { name: o.customerName, contact: o.customerPhone } };
  }

  /**
   * A second request carrying a nonce already used: the same phone retrying a checkout whose
   * answer it never received. The nonce is a random UUID only that phone ever held - stored as its
   * sha256, never logged or audited - so presenting it again is proof enough to hand the order
   * back. The secret, though, was only ever stored as a hash and cannot be repeated, so the order
   * is given a fresh one and the old one stops working. Only while it is still waiting for its
   * payment: a nonce whose order was paid, refunded or lapsed is spent.
   */
  async function replay(prior: QrOrderRow, code: QrCodeRow, gw: PaymentGateway, meta: RequestMeta): Promise<WriteResponse<QrOrderCreated>> {
    if (prior.qrCodeId !== code.id) throw new ConflictError("This checkout was already used for another order - reload the menu and try again.");
    const { order, secret } = await withTransaction(db, async (tx) => {
      const o = await qrOrderForUpdate(tx, prior.id);
      if (!o) throw new NotFoundError(ORDER_GONE);
      const now = new Date();
      if (o.status !== "Awaiting payment" || o.expiresAt <= now) {
        throw new ConflictError(o.status === "Awaiting payment" || o.status === "Expired"
          ? `Order ${o.id} lapsed before it was paid - start a new order.`
          : `Order ${o.id} has already been placed and paid - open its status page to follow it.`);
      }
      const fresh = randomBytes(32).toString("base64url");
      await qrRepo.setSecret(tx, o.id, sha256(fresh), now);
      await recordSystemEvent(tx, {
        action: "createQrOrder", subject: o.id, loc: o.loc, method: "POST", path: routes.createQrOrder.path,
        message: `Order ${o.id} handed back to the phone that placed it (a retried checkout)`,
        request: { params: { token: code.token } }, result: { id: o.id }, ...meta,
      });
      return { order: { ...o, secretHash: sha256(fresh) }, secret: fresh };
    });
    const checkout = await checkoutFor(order, gw);
    const view = await publicOrderOf(db, order);
    return { result: { order: view, secret, checkout }, changed: [], message: `Order ${order.id} is already placed - pay ${inr(order.total)} to confirm it.` };
  }

  /**
   * Settle a captured payment against an order - the one path both the browser's verify and the
   * gateway's webhook take, so whichever arrives first bills it and the other finds it done.
   *
   * Lock order: the order `FOR UPDATE`, then (inside `postSale`) the outlet, its register session,
   * the shelves and the bill number. The same payment again is a no-op answering the order as it
   * stands; a different payment on an order already settled is a second capture, refunded as a
   * duplicate. Otherwise the sale runs in a savepoint: anything it refuses (sold out, switched off,
   * the outlet closed, a price that moved since the quote) - or an amount that does not match -
   * makes no bill, and the order is Refunded with the whole payment queued to go back. A capture
   * that arrives after the order expired is billed or refunded the same way; it is never lost.
   */
  async function settleCapture(orderId: string, p: GatewayPayment, via: { method: string; path: string } & Partial<RequestMeta>): Promise<Settled> {
    const out = await withTransaction(db, async (tx): Promise<Settled> => {
      const o = await qrOrderForUpdate(tx, orderId);
      if (!o) throw new NotFoundError(ORDER_GONE);
      if (o.rzpPaymentId === p.id) return { order: o, changed: [], message: `Order ${o.id} was already settled by ${p.id}`, refundQueued: false };
      const amount = money2(p.amountPaise / 100);
      const at = new Date();
      const event = { subject: o.id, loc: o.loc, method: via.method, path: via.path, requestId: via.requestId, ip: via.ip, device: via.device };

      // A second payment against an order that already has one.
      if (o.rzpPaymentId || (o.status !== "Awaiting payment" && o.status !== "Expired")) {
        if (await qrRepo.refundOfPayment(tx, o.id, p.id)) return { order: o, changed: [], message: `Payment ${p.id} is already being refunded`, refundQueued: false };
        const r = await queueRefund(tx, { qrOrderId: o.id, paymentId: p.id, amount, reason: "duplicate", at });
        const message = `Order ${o.id} was paid twice - the second payment, ${inr(amount)}, is being refunded (${r.id})`;
        await recordSystemEvent(tx, { ...event, action: "qrOrderRefunded", message, result: { order: o.id, refund: r.id, payment: p.id, reason: "duplicate" } });
        await emitChanged(tx, ["qrOrders"]);
        return { order: o, changed: ["qrOrders"], message, refundQueued: true };
      }

      const operatorId = await systemOperator(tx);
      const lines = (await qrRepo.lines(tx, [o.id])).get(o.id) ?? [];
      let why: string | null = null;
      if (p.currency !== "INR" || p.amountPaise !== paise(o.total) || (p.orderId !== null && p.orderId !== o.rzpOrderId)) {
        why = `the payment of ${inr(amount)} did not match the order's ${inr(o.total)}`;
      }
      let sale: WriteResponse<Bill> | undefined;
      if (!why) {
        try {
          // A savepoint: a refused sale rolls back to here - its locks, its bill number and all -
          // and the refund below commits in its place.
          sale = await tx.transaction(async (sp) => {
            const s = await postSale(sp, {
              loc: o.loc, operatorId, lines: lines.map((l) => ({ it: l.itemKey, qty: l.qty })), tender: "Online",
              customer: { name: o.customerName, phone: o.customerPhone }, source: "qr", qrOrderId: o.id,
            });
            const moved = lines.find((l) => s.result.lines.find((b) => b.it === l.itemKey)?.rate !== l.rate);
            assertRule(!moved && s.result.tot === o.total, `the price of ${moved?.name ?? "the order"} changed after it was placed`);
            return s;
          });
        } catch (e) {
          if (!(e instanceof AppError) || e.status >= 500) throw e;
          why = e.message;
        }
      }

      if (sale) {
        const next = await moveQrOrder(tx, o, "Paid", SYSTEM_QR.name, { at, patch: { rzpPaymentId: p.id, billNo: sale.result.no, paidAt: at } });
        const message = `Order ${o.id} paid online - bill ${sale.result.no} · ${inr(sale.result.tot)} at ${(await qrRepo.location(tx, o.loc))?.name ?? o.loc}`;
        await recordSystemEvent(tx, { ...event, action: "qrOrderPaid", message, result: { order: o.id, bill: sale.result.no, payment: p.id, total: sale.result.tot } });
        const changed: Changed[] = [...new Set<Changed>([...sale.changed, "qrOrders"])];
        await emitChanged(tx, changed);
        return { order: next, changed, message, refundQueued: false };
      }
      const next = await moveQrOrder(tx, o, "Refunded", SYSTEM_QR.name, { at, note: why ?? undefined, patch: { rzpPaymentId: p.id } });
      const r = await queueRefund(tx, { qrOrderId: o.id, paymentId: p.id, amount, reason: "unfulfillable", at });
      const message = `Order ${o.id} could not be filled - ${why} - so ${inr(amount)} is being refunded (${r.id})`;
      await recordSystemEvent(tx, { ...event, action: "qrOrderRefunded", message, result: { order: o.id, refund: r.id, payment: p.id, reason: "unfulfillable" } });
      await emitChanged(tx, ["qrOrders"]);
      return { order: next, changed: ["qrOrders"], message, refundQueued: true };
    });
    if (out.refundQueued) nudge();
    return out;
  }

  /** What the gateway's webhook says a refund came to. A refund it names that we never sent (or
   *  already finished) changes nothing. */
  async function settleRefund(rzpRefundId: string, rid: string | undefined, outcome: "processed" | "failed", via: { method: string; path: string }): Promise<boolean> {
    return withTransaction(db, async (tx) => {
      const r = await qrRepo.refundForGateway(tx, rzpRefundId, rid);
      if (!r || (r.status !== "Pending" && r.status !== "Sent")) return false;
      const event = { subject: r.id, loc: (await qrRepo.order(tx, r.qrOrderId))?.loc, method: via.method, path: via.path };
      if (outcome === "processed") {
        if (r.status === "Pending") await moveRefund(tx, r.id, "Sent", { rzpRefundId });
        await moveRefund(tx, r.id, "Processed", { rzpRefundId });
        await recordSystemEvent(tx, { ...event, action: "qrRefundProcessed", message: `Refund ${r.id} of ${inr(r.amount)} reached the customer`, result: { refund: r.id, rzpRefundId } });
      } else {
        await moveRefund(tx, r.id, "Failed", { rzpRefundId, error: "The payment gateway reported that the refund failed" });
        await recordSystemEvent(tx, { ...event, action: "qrRefundFailed", message: `Refund ${r.id} of ${inr(r.amount)} failed at the payment gateway - a manager can retry it`, result: { refund: r.id, rzpRefundId } });
      }
      await emitChanged(tx, ["qrOrders", "bills"]);
      return true;
    });
  }

  return {
    settleCapture,

    // ---- the customer's side

    /** The menu a code opens: the outlet's till menu at the till's prices, with whether it takes
     *  orders now. A closed outlet still answers - with its menu shown closed. */
    async menu(token: string, now = new Date()): Promise<PublicMenu> {
      return withReadTransaction(db, async (tx) => {
        const code = await qrRepo.codeByToken(tx, token);
        if (!code || !code.active) throw new NotFoundError(CODE_GONE);
        const loc = (await qrRepo.location(tx, code.loc))!;
        const s = await sellableAt(tx, code.loc);
        const hours = await qrRepo.hoursOf(tx, code.loc);
        const paused = (await qrRepo.paused(tx, [code.loc]))[code.loc];
        const o = qrOpenAt(hours, now);
        const open = loc.active
          ? { open: o.open, ...(o.why ? { why: o.why } : {}), today: o.today }
          : { open: false, why: `${loc.name} is closed.`, today: null };
        return {
          outlet: { loc: loc.key, name: loc.name }, qr: { label: code.label, mode: code.mode }, open, paused,
          items: menuOf(s).map((l) => {
            const max = l.available ? Math.max(0, Math.min(QR_MAX_QTY, Math.floor(l.cover))) : 0;
            return {
              it: l.it, name: l.item.n, price: l.price, ...(l.mrp !== undefined ? { mrp: l.mrp } : {}),
              available: max > 0, ...(max > 0 ? {} : { why: l.why ?? `${l.item.n} is sold out` }), max,
              image: l.item.img ?? null, type: l.item.t,
            };
          }),
        };
      });
    },

    /**
     * Place an order: quote it, number it, store it, and only then - with the transaction
     * committed - ask the gateway for the checkout's order. Lock order: the code (`FOR SHARE`),
     * the outlet, the caps' advisory locks, then the `qr_order` number.
     */
    async place(token: string, body: CreateQrOrderBody, meta: RequestMeta): Promise<WriteResponse<QrOrderCreated>> {
      const code0 = await qrRepo.codeByToken(db, token);
      if (!code0 || !code0.active) throw new NotFoundError(CODE_GONE);
      const gw = gatewayOrOff();
      const phone = normalizePhone(body.phone);
      if (!phone) throw new RuleError(customerPhoneRefusal(body.phone));
      const nonce = sha256(body.nonce);
      const prior = await qrRepo.orderByNonce(db, nonce);
      if (prior) return replay(prior, code0, gw, meta);

      const secret = randomBytes(32).toString("base64url");
      let order: QrOrderRow;
      try {
        order = await withTransaction(db, async (tx) => {
          const code = await qrRepo.codeByTokenForShare(tx, token);
          if (!code || !code.active) throw new NotFoundError(CODE_GONE);
          const loc = await lockLocation(tx, code.loc);
          assertRule(loc.active, `${loc.name} is closed - please order at the counter.`);
          const now = new Date();
          const open = qrOpenAt(await qrRepo.hoursOf(tx, code.loc), now);
          assertRule(open.open, hoursRefusal(loc.name, open));
          assertRule(!(await qrRepo.paused(tx, [code.loc]))[code.loc], pausedRefusal(loc.name));

          await qrRepo.lockCaps(tx, phone, meta.ip);
          const pending = await qrRepo.pendingForPhone(tx, code.loc, phone, now);
          assertRule(pending < QR_PENDING_PER_PHONE,
            `You already have ${pending} unpaid orders at ${loc.name} - pay for one, or let it lapse, before placing another.`);
          if (await qrRepo.pendingForIp(tx, meta.ip, new Date(now.getTime() - IP_WINDOW_MS)) >= QR_PENDING_PER_IP) {
            throw new RateLimitedError("Too many unpaid orders from this connection - pay for one, or try again in a few minutes.");
          }

          const s = await sellableAt(tx, code.loc);
          const cart = cartOf(body.lines);
          for (const [it, n] of Object.entries(cart)) {
            assertRule(n <= QR_MAX_QTY, `One order can carry at most ${QR_MAX_QTY} of ${s.master.items[it]?.n ?? it}.`);
          }
          assertSellable(s, cart);
          const terms = await termsFor(tx, "customer");
          const plan = planBill(s.master, s.prices, code.loc, cart, terms.pct);
          const total = money2(plan.tot);
          assertRule(total > 0, "There is nothing to pay for on this order.");
          assertRule(total <= config.maxRupees,
            `One QR order can come to at most ${inr(config.maxRupees)} - this one is ${inr(total)}. Take a few items off, or order at the counter.`);

          const id = await allocateId(tx, "qr_order", now);
          const spot = code.mode === "deliver" ? body.detail ?? "" : "";
          const row = await qrRepo.insertOrder(tx, {
            id, loc: code.loc, qrCodeId: code.id, label: code.label, mode: code.mode, spot, status: "Awaiting payment",
            customerName: body.name, customerPhone: phone, total, tax: money2(plan.tax), discount: money2(plan.disc),
            secretHash: sha256(secret), nonce, ip: meta.ip, expiresAt: new Date(now.getTime() + config.ttlMin * 60_000),
            createdAt: now, updatedAt: now,
          }, plan.lines);
          await appendHistory(tx, "qr_order", id, "Awaiting payment", `${body.name} (customer)`, now);
          await recordSystemEvent(tx, {
            action: "createQrOrder", subject: id, loc: code.loc, method: "POST", path: routes.createQrOrder.path,
            message: `Order ${id} placed from ${code.label} at ${loc.name} · ${inr(total)}`,
            // The nonce is left out: it is what lets the phone retry, and nobody else needs it.
            request: { params: { token }, body: { name: body.name, phone, detail: body.detail, lines: body.lines } },
            result: { id, total }, ...meta,
          });
          return row;
        });
      } catch (e) {
        // Two requests with one nonce, at once: the insert decides, and the loser is a replay.
        if (!isUniqueViolation(e, "qr_orders_nonce_uq")) throw e;
        const winner = (await qrRepo.orderByNonce(db, nonce))!;
        return replay(winner, code0, gw, meta);
      }
      const checkout = await checkoutFor(order, gw);
      const view = await publicOrderOf(db, order);
      return { result: { order: view, secret, checkout }, changed: [], message: `Order ${order.id} placed - pay ${inr(order.total)} to confirm it.` };
    },

    /**
     * The checkout's success handler, forwarded by the phone. Every gateway call happens here,
     * before any transaction: the signature, the payment as the gateway reports it, and a capture
     * where it is only authorised. Then `settleCapture`, which the webhook reaches too.
     */
    async verify(id: string, body: VerifyQrPaymentBody, meta: RequestMeta): Promise<WriteResponse<PublicQrOrder>> {
      const gw = gatewayOrOff();
      const o = await qrRepo.order(db, id);
      if (!o || !secretMatches(o.secretHash, body.secret)) throw new NotFoundError(ORDER_GONE);
      if (!o.rzpOrderId || o.rzpOrderId !== body.razorpay_order_id) throw new ValidationError(`This payment is not for order ${o.id}.`);
      if (!gw.verifyCheckout(body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature)) {
        throw new ValidationError("This payment could not be verified - if money left your account, it will come back.");
      }
      let p: GatewayPayment;
      try {
        p = await gw.fetchPayment(body.razorpay_payment_id);
        if (p.orderId !== o.rzpOrderId) throw new ValidationError(`This payment is not for order ${o.id}.`);
        if (p.status === "authorized") {
          if (p.amountPaise !== paise(o.total)) throw new RuleError("The payment does not match this order - it will be released back to you.");
          try { p = await gw.capture(p.id, p.amountPaise); } catch (e) {
            // Captured by somebody else in the meantime (the gateway's own auto-capture, a webhook
            // path): the payment as it now stands is the answer, not the refusal.
            if (!(e instanceof GatewayError)) throw e;
            p = await gw.fetchPayment(p.id);
          }
        }
      } catch (e) {
        if (e instanceof GatewayError) throw new NotReadyError(VERIFY_LATER, e);
        throw e;
      }
      if (p.status !== "captured" && p.status !== "refunded") {
        throw new RuleError("The payment did not go through - you have not been charged. Tap Pay to try again.");
      }
      const settled = p.status === "captured"
        ? await settleCapture(o.id, p, { method: "POST", path: routes.verifyQrPayment.path, ...meta })
        : { order: o, changed: [] as Changed[], message: `Payment ${p.id} was already refunded` };
      return { result: await publicOrderOf(db, settled.order), changed: settled.changed, message: settled.message };
    },

    /** The status page's read, proved by the order's secret. A wrong secret is the same 404 as an
     *  order that does not exist. */
    async publicOrder(id: string, k: string): Promise<PublicQrOrder> {
      return withReadTransaction(db, async (tx) => {
        const o = await qrRepo.order(tx, id);
        if (!o || !secretMatches(o.secretHash, k)) throw new NotFoundError(ORDER_GONE);
        return publicOrderOf(tx, o);
      });
    },

    /**
     * The gateway's webhook. Signed, not authenticated: a signature that does not match is a 401,
     * a body that is not JSON a 400, and everything the API does not act on a 200. A delivery
     * whose event id was already handled is acknowledged and dropped; every handler is idempotent
     * on its own as well, so two deliveries racing past that check settle once.
     */
    async webhook(raw: Buffer, signature: string | undefined, eventId: string | undefined, via: { method: string; path: string } & Partial<RequestMeta>): Promise<{ ok: true; duplicate?: true }> {
      const gw = gatewayOrOff();
      if (!signature || !gw.verifyWebhook(raw, signature)) throw new UnauthenticatedError("The webhook signature does not match.", "bad webhook signature");
      let body: WebhookBody;
      try { body = JSON.parse(raw.toString("utf8")) as WebhookBody; } catch { throw new ValidationError("The webhook body is not JSON."); }
      if (eventId && await qrRepo.webhookSeen(db, eventId)) return { ok: true, duplicate: true };
      const event = typeof body?.event === "string" ? body.event : "";
      if (event === "payment.captured" || event === "order.paid") {
        const p = paymentOf(body.payload?.payment?.entity);
        const order = p?.orderId ? await qrRepo.orderByRzpOrder(db, p.orderId) : undefined;
        if (p && order && p.status === "captured") await settleCapture(order.id, p, via);
      } else if (event === "refund.processed" || event === "refund.failed") {
        const r = body.payload?.refund?.entity;
        if (r && typeof r.id === "string") {
          const rid = r.notes && typeof r.notes === "object" && !Array.isArray(r.notes) && typeof r.notes.rid === "string" ? r.notes.rid : undefined;
          await settleRefund(r.id, rid, event === "refund.processed" ? "processed" : "failed", via);
        }
      }
      if (eventId) await withTransaction(db, (tx) => qrRepo.markWebhook(tx, eventId, event.slice(0, 64)));
      return { ok: true };
    },

    // ---- the counter's queue

    async queue(actor: Actor, now = new Date()): Promise<QrOrdersResponse> {
      return withReadTransaction(db, async (tx) => {
        const locs = actor.wide ? await qrRepo.outletKeys(tx) : [actor.loc];
        const orders = await qrRepo.queue(tx, locs, LIVE, DONE, dateAt(istDate(now), "00:00"));
        const ids = orders.map((o) => o.id);
        const lines = await qrRepo.lines(tx, ids);
        const refunds = await qrRepo.refunds(tx, ids);
        const hist = await qrRepo.histories(tx, ids);
        return {
          orders: orders.map((o) => toStaffOrder(o, lines.get(o.id), refunds.get(o.id), hist.get(o.id) ?? [])),
          paused: await qrRepo.paused(tx, locs),
          hours: await qrRepo.hours(tx, locs),
        };
      });
    },

    /** The counter's next step: exactly the one `nextQrStep` names for the order's mode. `Voided`
     *  is never a step - it comes with the void of the bill behind the order. */
    async setStatus(actor: Actor, id: string, to: QrOrderStatus): Promise<WriteResponse<QrOrder>> {
      return withTransaction(db, async (tx) => {
        const o = await qrOrderForUpdate(tx, id);
        if (!o) throw new NotFoundError(`There is no QR order ${id}.`);
        if (!actor.wide) requireLocOf(actor, o.loc, "your own counter's QR orders");
        assertRule(to !== "Voided", `A QR order is voided with its bill - void ${o.billNo ?? "its bill"} instead.`);
        const step = nextQrStep(o.mode, o.status);
        assertRule(step === to, step
          ? `${o.id} is ${o.status.toLowerCase()} - its next step is ${step.toLowerCase()}.`
          : `${o.id} is ${o.status.toLowerCase()} and has no next step.`);
        const next = await moveQrOrder(tx, o, to, await qrRepo.userName(tx, actor.sub));
        await emitChanged(tx, ["qrOrders"]);
        const lines = (await qrRepo.lines(tx, [id])).get(id);
        const refunds = (await qrRepo.refunds(tx, [id])).get(id);
        const hist = (await qrRepo.histories(tx, [id])).get(id) ?? [];
        return { result: toStaffOrder(next, lines, refunds, hist), changed: ["qrOrders"], message: `${o.id} for ${o.customerName} (${o.label}) is ${to.toLowerCase()}` };
      });
    },

    async setPause(userId: string, loc: string, paused: boolean): Promise<WriteResponse<QrPauseResult>> {
      return withTransaction(db, async (tx) => {
        const row = await lockOutlet(tx, loc);
        assertRule(row.active, `Refused - ${row.name} is closed`);
        const was = await qrRepo.pausedForUpdate(tx, loc);
        auditBefore({ paused: was });
        assertRule(was !== paused, `QR ordering at ${row.name} is already ${paused ? "paused" : "on"}`);
        await qrRepo.setPaused(tx, loc, paused, userId, new Date());
        await emitChanged(tx, ["qrOrders"]);
        return {
          result: { loc, paused }, changed: ["qrOrders"],
          message: paused
            ? `QR ordering at ${row.name} is paused - new orders are refused until you resume it`
            : `QR ordering at ${row.name} is back on`,
        };
      });
    },

    /** A Failed refund back in the queue, attempts from nothing, due now. */
    async retryRefund(id: string): Promise<WriteResponse<QrRefund>> {
      const out = await withTransaction(db, async (tx) => {
        const r = await qrRepo.refundForUpdate(tx, id);
        if (!r) throw new NotFoundError(`There is no refund ${id}.`);
        auditBefore({ status: r.status, attempts: r.attempts, lastError: r.lastError ?? undefined });
        assertRule(r.status === "Failed", `Refund ${id} is ${r.status.toLowerCase()} - only a failed refund can be retried`);
        const next = await moveRefund(tx, id, "Pending");
        await emitChanged(tx, ["qrOrders", "bills"]);
        return { result: toWireRefund(next), changed: ["qrOrders", "bills"] as Changed[], message: `Refund ${id} of ${inr(next.amount)} is queued again - it goes to the payment gateway shortly` };
      });
      nudge();
      return out;
    },

    // ---- the super admin's codes and hours

    async adminCodes(): Promise<AdminQrCodesResponse> {
      return withReadTransaction(db, async (tx) => ({
        codes: (await qrRepo.codes(tx)).map(toAdminCode),
        hours: await qrRepo.hours(tx, await qrRepo.outletKeys(tx)),
      }));
    },

    async createCode(body: CreateQrCodeBody): Promise<WriteResponse<AdminQrCode>> {
      return withTransaction(db, async (tx) => {
        const row = await lockOutlet(tx, body.loc);
        assertRule(row.active, `Refused - ${row.name} is closed; reopen it before adding a QR code`);
        const id = await allocateId(tx, "qr_code");
        const code = await qrRepo.insertCode(tx, { id, loc: body.loc, label: body.label, mode: body.mode, token: newToken(), active: true });
        await emitChanged(tx, ["qrCodes"]);
        return { result: toAdminCode(code), changed: ["qrCodes"], message: `Created ${id} "${body.label}" at ${row.name} - download its poster to print it` };
      });
    },

    async updateCode(id: string, body: UpdateQrCodeBody): Promise<WriteResponse<AdminQrCode>> {
      return withTransaction(db, async (tx) => {
        const c = await qrRepo.codeForUpdate(tx, id);
        if (!c) throw new NotFoundError(`There is no QR code ${id}.`);
        auditBefore({ label: c.label, mode: c.mode, active: c.active });
        const patch: Partial<Pick<QrCodeRow, "label" | "mode" | "active">> = {};
        if (body.label !== undefined && body.label !== c.label) patch.label = body.label;
        if (body.mode !== undefined && body.mode !== c.mode) patch.mode = body.mode;
        if (body.active !== undefined && body.active !== c.active) patch.active = body.active;
        if (Object.keys(patch).length === 0) throw new RuleError(`Nothing to save - ${id} already reads that way`);
        const next = await qrRepo.updateCode(tx, id, patch);
        await emitChanged(tx, ["qrCodes"]);
        const message = patch.active === false
          ? `${id} "${next.label}" is switched off - its poster no longer opens the menu`
          : patch.active === true ? `${id} "${next.label}" is switched back on` : `${id} "${next.label}" saved`;
        return { result: toAdminCode(next), changed: ["qrCodes"], message };
      });
    },

    async regenerateCode(id: string): Promise<WriteResponse<AdminQrCode>> {
      return withTransaction(db, async (tx) => {
        const c = await qrRepo.codeForUpdate(tx, id);
        if (!c) throw new NotFoundError(`There is no QR code ${id}.`);
        auditBefore({ token: c.token, rotatedAt: c.rotatedAt ? iso(c.rotatedAt) : undefined });
        const next = await qrRepo.updateCode(tx, id, { token: newToken(), rotatedAt: new Date() });
        await emitChanged(tx, ["qrCodes"]);
        return { result: toAdminCode(next), changed: ["qrCodes"], message: `${id} "${next.label}" has a new code - print its poster again; the old one no longer works` };
      });
    },

    async setHours(loc: string, days: OrderHoursDay[]): Promise<WriteResponse<OrderHours>> {
      return withTransaction(db, async (tx) => {
        const row = await lockOutlet(tx, loc);
        auditBefore({ days: await qrRepo.hoursOf(tx, loc) });
        const sorted = [...days].sort((a, b) => a.dow - b.dow);
        await qrRepo.replaceHours(tx, loc, sorted);
        await emitChanged(tx, ["qrCodes"]);
        const n = sorted.length;
        return {
          result: { loc, days: sorted }, changed: ["qrCodes"],
          message: n === 0
            ? `Ordering hours saved for ${row.name} - it takes no QR orders on any day`
            : `Ordering hours saved for ${row.name} - QR orders ${n === 7 ? "every day" : `${n} day${n === 1 ? "" : "s"} a week`}`,
        };
      });
    },
  };
}


// ---- the webhook's JSON, read defensively: only what the handlers use is trusted, and only once
// its type is checked.
type Json = Record<string, unknown>;
type WebhookBody = {
  event?: unknown;
  payload?: { payment?: { entity?: Json }; refund?: { entity?: { id?: unknown; notes?: Record<string, unknown> | unknown[] } } };
};

function paymentOf(e: Json | undefined): GatewayPayment | null {
  if (!e || typeof e.id !== "string" || typeof e.amount !== "number" || typeof e.currency !== "string" || typeof e.status !== "string") return null;
  return {
    id: e.id, orderId: typeof e.order_id === "string" ? e.order_id : null, amountPaise: e.amount, currency: e.currency,
    status: e.status as GatewayPayment["status"], method: typeof e.method === "string" ? e.method : null, error: null,
  };
}
