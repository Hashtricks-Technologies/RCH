import { GatewayError, hmacHex, signatureMatches, type GatewayOrder, type GatewayPayment, type GatewayPaymentStatus, type GatewayRefund, type GatewayRefundStatus, type Notes, type PaymentGateway } from "../lib/payments.js";

/**
 * A payment gateway that lives in memory, for the QR tests (`buildApp(config, { payments })`).
 * It keeps orders, payments and refunds the way the gateway would, records every call, and signs
 * the checkout and webhooks with fixed secrets through the same HMAC the real one verifies with -
 * so a test proves the signature check, not a stub of it.
 *
 * - `pay(orderId)` is a customer paying at checkout: a payment against the order (captured by
 *   default, or `authorized`/`failed`), and the checkout signature the phone would forward.
 * - `failNext(method, error)` makes the next call of that method throw, once - a timeout, a 5xx
 *   or the gateway refusing a refund.
 * - `refundStatus` is what a new refund is created as (`pending` by default; `processed` is what
 *   a test key often answers at once).
 */
export const FAKE_KEY_ID = "rzp_test_fake";
export const FAKE_KEY_SECRET = "fake-key-secret";
export const FAKE_WEBHOOK_SECRET = "fake-webhook-secret";

type Method = "createOrder" | "fetchPayment" | "capture" | "refund" | "refundsOf";
export type FakeGateway = PaymentGateway & {
  calls: Array<{ method: Method; args: unknown[] }>;
  orders: Map<string, GatewayOrder & { notes: Notes }>;
  payments: Map<string, GatewayPayment>;
  refunds: GatewayRefund[];
  refundStatus: GatewayRefundStatus;
  pay(orderId: string, o?: { status?: GatewayPaymentStatus; amountPaise?: number; id?: string }): { paymentId: string; signature: string };
  signCheckout(orderId: string, paymentId: string): string;
  signWebhook(body: string | Buffer): string;
  failNext(method: Method, error?: GatewayError): void;
  /** Settle a refund at the gateway, as its `refund.processed` / `refund.failed` would report. */
  settleRefund(refundId: string, status: GatewayRefundStatus): GatewayRefund;
};

export function createFakeGateway(): FakeGateway {
  let n = 0;
  const next = (prefix: string) => `${prefix}_fake${String(++n).padStart(6, "0")}`;
  const failures = new Map<Method, GatewayError>();
  const fake: FakeGateway = {
    keyId: FAKE_KEY_ID,
    calls: [], orders: new Map(), payments: new Map(), refunds: [], refundStatus: "pending",
    failNext(method, error = new GatewayError("The payment gateway could not be reached", 0, "network", true)) { failures.set(method, error); },
    signCheckout: (orderId, paymentId) => hmacHex(FAKE_KEY_SECRET, `${orderId}|${paymentId}`),
    signWebhook: (body) => hmacHex(FAKE_WEBHOOK_SECRET, body),
    pay(orderId, o = {}) {
      const order = fake.orders.get(orderId);
      if (!order) throw new Error(`fake gateway: no order ${orderId}`);
      const id = o.id ?? next("pay");
      fake.payments.set(id, {
        id, orderId, amountPaise: o.amountPaise ?? order.amountPaise, currency: "INR", status: o.status ?? "captured",
        method: "upi", error: o.status === "failed" ? "Payment failed" : null,
      });
      return { paymentId: id, signature: fake.signCheckout(orderId, id) };
    },
    settleRefund(refundId, status) {
      const r = fake.refunds.find((x) => x.id === refundId);
      if (!r) throw new Error(`fake gateway: no refund ${refundId}`);
      r.status = status;
      return { ...r };
    },
    async createOrder(o) {
      record("createOrder", [o]);
      const order = { id: next("order"), amountPaise: o.amountPaise, currency: "INR", receipt: o.receipt, status: "created", notes: o.notes ?? {} };
      fake.orders.set(order.id, order);
      return { id: order.id, amountPaise: order.amountPaise, currency: order.currency, receipt: order.receipt, status: order.status };
    },
    async fetchPayment(id) {
      record("fetchPayment", [id]);
      return { ...payment(id) };
    },
    async capture(id, amountPaise) {
      record("capture", [id, amountPaise]);
      const p = payment(id);
      if (p.status !== "authorized") throw new GatewayError("This payment has already been captured", 400, "BAD_REQUEST_ERROR", false);
      if (p.amountPaise !== amountPaise) throw new GatewayError("Capture amount must be equal to the amount authorized", 400, "BAD_REQUEST_ERROR", false);
      p.status = "captured";
      return { ...p };
    },
    async refund(paymentId, r) {
      record("refund", [paymentId, r]);
      const p = payment(paymentId);
      const already = fake.refunds.filter((x) => x.paymentId === paymentId && x.status !== "failed").reduce((a, x) => a + x.amountPaise, 0);
      if (already + r.amountPaise > p.amountPaise) throw new GatewayError("The refund amount provided is greater than amount captured", 400, "BAD_REQUEST_ERROR", false);
      const refund: GatewayRefund = { id: next("rfnd"), paymentId, amountPaise: r.amountPaise, status: fake.refundStatus, receipt: r.receipt, notes: r.notes ?? {} };
      fake.refunds.push(refund);
      return { ...refund };
    },
    async refundsOf(paymentId) {
      record("refundsOf", [paymentId]);
      return fake.refunds.filter((x) => x.paymentId === paymentId).map((x) => ({ ...x }));
    },
    verifyCheckout: (orderId, paymentId, signature) => signatureMatches(fake.signCheckout(orderId, paymentId), signature),
    verifyWebhook: (rawBody, signature) => signatureMatches(fake.signWebhook(rawBody), signature),
  };
  function record(method: Method, args: unknown[]): void {
    fake.calls.push({ method, args });
    const f = failures.get(method);
    if (f) { failures.delete(method); throw f; }
  }
  function payment(id: string): GatewayPayment {
    const p = fake.payments.get(id);
    if (!p) throw new GatewayError("The id provided does not exist", 400, "BAD_REQUEST_ERROR", false);
    return p;
  }
  return fake;
}
