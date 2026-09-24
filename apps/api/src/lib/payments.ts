import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The payment gateway, behind one small interface: `lib/payments.ts` is the only code that talks
 * to it, the way `lib/images.ts` is the only code that touches photo bytes. `createRazorpayGateway`
 * is the real one - Razorpay's REST API over plain `fetch`, no SDK - and the tests inject a fake
 * (`src/test/fake-gateway.ts`) through `AppDeps.payments`. `app.payments` is null when the keys
 * are not set (`config.razorpay`), and QR ordering then refuses to take an order.
 *
 * **Nothing here is called inside a database transaction.** A network call holding row locks would
 * put every till at that outlet behind a gateway's latency; the QR module asks the gateway first
 * and writes after, or writes first and lets the worker send.
 *
 * Amounts are whole paise, as the gateway counts them (`paise` in @rch/domain).
 */
export type GatewayOrder = { id: string; amountPaise: number; currency: string; receipt: string | null; status: string };
/** A payment as the gateway reports it. `authorized` is money held but not yet taken; only
 *  `captured` is money the hospital has. */
export type GatewayPaymentStatus = "created" | "authorized" | "captured" | "refunded" | "failed";
export type GatewayPayment = {
  id: string; orderId: string | null; amountPaise: number; currency: string; status: GatewayPaymentStatus;
  method: string | null; error: string | null;
};
export type GatewayRefundStatus = "pending" | "processed" | "failed";
export type GatewayRefund = {
  id: string; paymentId: string; amountPaise: number; status: GatewayRefundStatus;
  receipt: string | null; notes: Record<string, string>;
};
export type Notes = Record<string, string>;

export interface PaymentGateway {
  /** Public: the order page hands it to the gateway's checkout. */
  readonly keyId: string;
  createOrder(o: { amountPaise: number; receipt: string; notes?: Notes }): Promise<GatewayOrder>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  /** Take an authorised payment. Harmless to call on one already captured - the gateway refuses
   *  it, and the caller reads the payment back rather than trusting either answer. */
  capture(paymentId: string, amountPaise: number): Promise<GatewayPayment>;
  refund(paymentId: string, r: { amountPaise: number; receipt: string; notes?: Notes }): Promise<GatewayRefund>;
  /** Every payment made against one of the gateway's orders, whatever became of it - how the
   *  worker's reconcile pass finds a payment whose verify and webhook both went missing. */
  paymentsOfOrder(orderId: string): Promise<GatewayPayment[]>;
  /** One refund as the gateway now reports it - how the worker settles a refund whose
   *  `refund.processed` / `refund.failed` webhook never arrived. */
  fetchRefund(paymentId: string, refundId: string): Promise<GatewayRefund>;
  /** Every refund already made against a payment - how a retry finds the one it sent before
   *  (by the `notes.rid` it set) instead of sending a second. */
  refundsOf(paymentId: string): Promise<GatewayRefund[]>;
  /** The checkout's success handler: `hmac(order_id|payment_id)` under the key secret. */
  verifyCheckout(orderId: string, paymentId: string, signature: string): boolean;
  /** A webhook's `X-Razorpay-Signature`: `hmac(raw body)` under the webhook secret. */
  verifyWebhook(rawBody: Buffer, signature: string): boolean;
}

/**
 * The gateway said no, or could not be reached. `retryable` is what the refund worker backs off
 * on: a network failure, a timeout, a 429 or a 5xx may go through next time; any other 4xx is the
 * gateway refusing the request itself and will refuse it again. `message` is the gateway's own
 * description where it gave one - it is what a Failed refund shows the manager.
 */
export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(message: string, status: number, code: string, retryable: boolean) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** HMAC-SHA256 as lowercase hex - how the gateway signs both the checkout and a webhook. */
export const hmacHex = (secret: string, payload: string | Buffer): string => createHmac("sha256", secret).update(payload).digest("hex");

/** Constant-time comparison of a signature against the one expected. Anything not the right
 *  length of hex is false without a comparison, since `timingSafeEqual` throws on a length
 *  mismatch and the length of a hex digest is no secret. */
export function signatureMatches(expected: string, given: string): boolean {
  if (!/^[0-9a-f]+$/i.test(given) || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(given.toLowerCase(), "utf8"));
}

export type RazorpayConfig = { keyId: string; keySecret: string; webhookSecret: string };
type Fetch = typeof fetch;

const API = "https://api.razorpay.com/v1";
/** A gateway call that has not answered in this long is a failure the worker retries, not a
 *  request left hanging on a customer's verify. */
const TIMEOUT_MS = 10_000;

// ---- the gateway's JSON, read defensively: every field the code relies on is checked here, so a
// shape the gateway changes becomes a GatewayError rather than an `undefined` in a bill.
type Json = Record<string, unknown>;
const str = (o: Json, k: string): string => {
  const v = o[k];
  if (typeof v !== "string") throw new GatewayError(`Unexpected answer from the payment gateway (${k})`, 502, "bad_response", true);
  return v;
};
const num = (o: Json, k: string): number => {
  const v = o[k];
  if (typeof v !== "number") throw new GatewayError(`Unexpected answer from the payment gateway (${k})`, 502, "bad_response", true);
  return v;
};
const optStr = (o: Json, k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);
/** The gateway sends an empty `notes` as `[]` and a full one as an object. */
const notesOf = (v: unknown): Notes =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Json).filter(([, x]) => typeof x === "string")) as Notes
    : {};

const toPayment = (p: Json): GatewayPayment => ({
  id: str(p, "id"), orderId: optStr(p, "order_id"), amountPaise: num(p, "amount"), currency: str(p, "currency"),
  status: str(p, "status") as GatewayPaymentStatus, method: optStr(p, "method"), error: optStr(p, "error_description"),
});
const toRefund = (r: Json): GatewayRefund => ({
  id: str(r, "id"), paymentId: str(r, "payment_id"), amountPaise: num(r, "amount"),
  // An older refund answer carries no status at all; a refund the gateway has accepted and not
  // yet settled is what that means.
  status: (optStr(r, "status") ?? "pending") as GatewayRefundStatus,
  receipt: optStr(r, "receipt"), notes: notesOf(r.notes),
});

/** A collection's `items`, each an object. */
const itemsOf = (r: Json): Json[] => {
  const items = r.items;
  if (!Array.isArray(items)) throw new GatewayError("Unexpected answer from the payment gateway (items)", 502, "bad_response", true);
  return items as Json[];
};

/** The real gateway. `fetchImpl` is injectable so the unit tests can stand in for the network. */
export function createRazorpayGateway(cfg: RazorpayConfig, fetchImpl: Fetch = fetch): PaymentGateway {
  const auth = `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64")}`;

  async function call(method: "GET" | "POST", path: string, body?: Json): Promise<Json> {
    let res: Response;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method,
        headers: { authorization: auth, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new GatewayError(timedOut ? "The payment gateway did not answer in time" : "The payment gateway could not be reached", 0, timedOut ? "timeout" : "network", true);
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: an HTML error page from a proxy */ }
    if (!res.ok) {
      const err = (json as { error?: Json } | null)?.error;
      const description = err && typeof err.description === "string" ? err.description : `The payment gateway answered ${res.status}`;
      const code = err && typeof err.code === "string" ? err.code : "http_error";
      throw new GatewayError(description, res.status, code, res.status === 429 || res.status >= 500);
    }
    if (!json || typeof json !== "object") throw new GatewayError("Unexpected answer from the payment gateway", 502, "bad_response", true);
    return json as Json;
  }
  const enc = encodeURIComponent;

  return {
    keyId: cfg.keyId,
    async createOrder(o) {
      const r = await call("POST", "/orders", { amount: o.amountPaise, currency: "INR", receipt: o.receipt, notes: o.notes ?? {} });
      return { id: str(r, "id"), amountPaise: num(r, "amount"), currency: str(r, "currency"), receipt: optStr(r, "receipt"), status: str(r, "status") };
    },
    async fetchPayment(id) {
      return toPayment(await call("GET", `/payments/${enc(id)}`));
    },
    async capture(id, amountPaise) {
      return toPayment(await call("POST", `/payments/${enc(id)}/capture`, { amount: amountPaise, currency: "INR" }));
    },
    async refund(paymentId, r) {
      return toRefund(await call("POST", `/payments/${enc(paymentId)}/refund`, { amount: r.amountPaise, speed: "normal", receipt: r.receipt, notes: r.notes ?? {} }));
    },
    async paymentsOfOrder(orderId) {
      return itemsOf(await call("GET", `/orders/${enc(orderId)}/payments`)).map(toPayment);
    },
    async fetchRefund(paymentId, refundId) {
      return toRefund(await call("GET", `/payments/${enc(paymentId)}/refunds/${enc(refundId)}`));
    },
    async refundsOf(paymentId) {
      return itemsOf(await call("GET", `/payments/${enc(paymentId)}/refunds?count=100`)).map(toRefund);
    },
    verifyCheckout(orderId, paymentId, signature) {
      return signatureMatches(hmacHex(cfg.keySecret, `${orderId}|${paymentId}`), signature);
    },
    verifyWebhook(rawBody, signature) {
      return signatureMatches(hmacHex(cfg.webhookSecret, rawBody), signature);
    },
  };
}
