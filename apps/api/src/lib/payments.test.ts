import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { buildTestApp } from "../test/app.js";
import { createFakeGateway, FAKE_KEY_ID } from "../test/fake-gateway.js";
import { createRazorpayGateway, GatewayError, hmacHex, signatureMatches } from "./payments.js";

const cfg = { keyId: "rzp_test_abc", keySecret: "key-secret", webhookSecret: "hook-secret" };

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };
/** A `fetch` that answers from a script and remembers what it was asked. */
function stub(...answers: Array<{ status?: number; body?: unknown; text?: string } | Error>) {
  const seen: Seen[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url), method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const a = answers.shift();
    if (!a) throw new Error("stub: no answer left");
    if (a instanceof Error) throw a;
    return new Response(a.text ?? JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { impl, seen };
}

const payment = { id: "pay_1", entity: "payment", amount: 12_000, currency: "INR", status: "captured", order_id: "order_1", method: "upi", error_description: null };
const refund = { id: "rfnd_1", entity: "refund", amount: 5_000, currency: "INR", payment_id: "pay_1", notes: { rid: "QO-2026-0001-R1" }, receipt: "QO-2026-0001-R1", status: "processed" };

describe("the Razorpay gateway", () => {
  it("creates an order in paise with basic auth, and reads the answer back", async () => {
    const { impl, seen } = stub({ body: { id: "order_1", entity: "order", amount: 12_000, currency: "INR", receipt: "QO-2026-0001", status: "created", notes: [] } });
    const g = createRazorpayGateway(cfg, impl);
    expect(g.keyId).toBe("rzp_test_abc");
    expect(await g.createOrder({ amountPaise: 12_000, receipt: "QO-2026-0001", notes: { qo: "QO-2026-0001" } }))
      .toEqual({ id: "order_1", amountPaise: 12_000, currency: "INR", receipt: "QO-2026-0001", status: "created" });
    expect(seen[0].url).toBe("https://api.razorpay.com/v1/orders");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.authorization).toBe(`Basic ${Buffer.from("rzp_test_abc:key-secret").toString("base64")}`);
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(seen[0].body).toEqual({ amount: 12_000, currency: "INR", receipt: "QO-2026-0001", notes: { qo: "QO-2026-0001" } });
  });
  it("fetches and captures a payment", async () => {
    const { impl, seen } = stub({ body: { ...payment, status: "authorized" } }, { body: payment });
    const g = createRazorpayGateway(cfg, impl);
    expect(await g.fetchPayment("pay_1")).toEqual({ id: "pay_1", orderId: "order_1", amountPaise: 12_000, currency: "INR", status: "authorized", method: "upi", error: null });
    expect((await g.capture("pay_1", 12_000)).status).toBe("captured");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://api.razorpay.com/v1/payments/pay_1",
      "POST https://api.razorpay.com/v1/payments/pay_1/capture",
    ]);
    expect(seen[0].headers["content-type"]).toBeUndefined();
    expect(seen[1].body).toEqual({ amount: 12_000, currency: "INR" });
  });
  it("refunds a payment with its receipt and notes, and lists a payment's refunds", async () => {
    const { impl, seen } = stub({ body: refund }, { body: { entity: "collection", count: 2, items: [refund, { ...refund, id: "rfnd_2", notes: [], receipt: null, status: undefined }] } });
    const g = createRazorpayGateway(cfg, impl);
    expect(await g.refund("pay_1", { amountPaise: 5_000, receipt: "QO-2026-0001-R1", notes: { rid: "QO-2026-0001-R1" } }))
      .toEqual({ id: "rfnd_1", paymentId: "pay_1", amountPaise: 5_000, status: "processed", receipt: "QO-2026-0001-R1", notes: { rid: "QO-2026-0001-R1" } });
    expect(seen[0].url).toBe("https://api.razorpay.com/v1/payments/pay_1/refund");
    expect(seen[0].body).toEqual({ amount: 5_000, speed: "normal", receipt: "QO-2026-0001-R1", notes: { rid: "QO-2026-0001-R1" } });
    const all = await g.refundsOf("pay_1");
    expect(seen[1].url).toBe("https://api.razorpay.com/v1/payments/pay_1/refunds?count=100");
    // An empty `notes` comes as `[]`, and an answer with no status is one not yet settled.
    expect(all[1]).toEqual({ id: "rfnd_2", paymentId: "pay_1", amountPaise: 5_000, status: "pending", receipt: null, notes: {} });
  });
  it("escapes an id in the path", async () => {
    const { impl, seen } = stub({ body: payment });
    await createRazorpayGateway(cfg, impl).fetchPayment("pay/../orders");
    expect(seen[0].url).toBe("https://api.razorpay.com/v1/payments/pay%2F..%2Forders");
  });

  it("turns the gateway's refusal into a GatewayError carrying its description, not retryable", async () => {
    const { impl } = stub({ status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "The refund amount provided is greater than amount captured" } } });
    const e = await createRazorpayGateway(cfg, impl).refund("pay_1", { amountPaise: 1, receipt: "r" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GatewayError);
    expect(e).toMatchObject({ message: "The refund amount provided is greater than amount captured", status: 400, code: "BAD_REQUEST_ERROR", retryable: false });
  });
  it("marks a 5xx, a 429, a network failure and a timeout retryable", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const { impl } = stub({ status: 502, text: "<html>Bad gateway</html>" }, { status: 429, body: { error: { code: "TOO_MANY", description: "Slow down" } } }, new TypeError("fetch failed"), timeout);
    const g = createRazorpayGateway(cfg, impl);
    const errs: GatewayError[] = [];
    for (let i = 0; i < 4; i++) errs.push((await g.fetchPayment("pay_1").catch((x: unknown) => x)) as GatewayError);
    expect(errs.map((e) => [e.status, e.code, e.retryable, e.message])).toEqual([
      [502, "http_error", true, "The payment gateway answered 502"],
      [429, "TOO_MANY", true, "Slow down"],
      [0, "network", true, "The payment gateway could not be reached"],
      [0, "timeout", true, "The payment gateway did not answer in time"],
    ]);
  });
  it("refuses an answer that is not the shape it relies on", async () => {
    const { impl } = stub({ body: { id: "pay_1" } }, { text: "" }, { body: { entity: "collection" } }, { body: { ...payment, currency: 5 } });
    const g = createRazorpayGateway(cfg, impl);
    await expect(g.fetchPayment("pay_1")).rejects.toMatchObject({ code: "bad_response", message: "Unexpected answer from the payment gateway (amount)" });
    await expect(g.fetchPayment("pay_1")).rejects.toMatchObject({ code: "bad_response", message: "Unexpected answer from the payment gateway" });
    await expect(g.refundsOf("pay_1")).rejects.toMatchObject({ code: "bad_response", message: "Unexpected answer from the payment gateway (items)" });
    await expect(g.fetchPayment("pay_1")).rejects.toMatchObject({ message: "Unexpected answer from the payment gateway (currency)" });
  });

  it("verifies the checkout signature over order_id|payment_id with the key secret", () => {
    const g = createRazorpayGateway(cfg, stub().impl);
    const good = createHmac("sha256", "key-secret").update("order_1|pay_1").digest("hex");
    expect(g.verifyCheckout("order_1", "pay_1", good)).toBe(true);
    expect(g.verifyCheckout("order_1", "pay_1", good.toUpperCase())).toBe(true);
    expect(g.verifyCheckout("order_1", "pay_2", good)).toBe(false);
    expect(g.verifyCheckout("order_1", "pay_1", createHmac("sha256", "hook-secret").update("order_1|pay_1").digest("hex"))).toBe(false);
    expect(g.verifyCheckout("order_1", "pay_1", good.slice(1))).toBe(false);
    expect(g.verifyCheckout("order_1", "pay_1", "z".repeat(64))).toBe(false);
  });
  it("verifies a webhook over its raw bytes with the webhook secret", () => {
    const g = createRazorpayGateway(cfg, stub().impl);
    const body = Buffer.from('{"event":"payment.captured","payload":{}}');
    const sig = createHmac("sha256", "hook-secret").update(body).digest("hex");
    expect(g.verifyWebhook(body, sig)).toBe(true);
    // Re-serialised JSON is not the bytes that were signed.
    expect(g.verifyWebhook(Buffer.from('{"event": "payment.captured","payload":{}}'), sig)).toBe(false);
    expect(g.verifyWebhook(body, createHmac("sha256", "key-secret").update(body).digest("hex"))).toBe(false);
    expect(g.verifyWebhook(body, "")).toBe(false);
  });
  it("compares signatures of different lengths without throwing", () => {
    expect(signatureMatches(hmacHex("s", "x"), "ab")).toBe(false);
    expect(signatureMatches("ab", "ab")).toBe(true);
  });
});

describe("the payments plugin", () => {
  it("is null with no keys", async () => {
    const app = await buildTestApp({ withDb: false });
    await app.ready();
    expect(app.payments).toBeNull();
    await app.close();
  });
  it("is the Razorpay gateway with all three keys", async () => {
    const app = await buildTestApp({ withDb: false, env: { RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: "a", RAZORPAY_WEBHOOK_SECRET: "b" } });
    await app.ready();
    expect(app.payments?.keyId).toBe("rzp_test_abc");
    await app.close();
  });
  it("uses an injected gateway as given, a fake included", async () => {
    const fake = createFakeGateway();
    const app = await buildTestApp({ withDb: false, payments: fake });
    await app.ready();
    expect(app.payments).toBe(fake);
    expect(app.payments?.keyId).toBe(FAKE_KEY_ID);
    await app.close();
    const off = await buildTestApp({ withDb: false, env: { RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: "a", RAZORPAY_WEBHOOK_SECRET: "b" }, payments: null });
    await off.ready();
    expect(off.payments).toBeNull();
    await off.close();
  });
});

describe("the fake gateway", () => {
  it("keeps orders, payments and refunds the way the gateway would, and signs what the real one verifies", async () => {
    const g = createFakeGateway();
    const order = await g.createOrder({ amountPaise: 10_000, receipt: "QO-1" });
    const { paymentId, signature } = g.pay(order.id, { status: "authorized" });
    expect(g.verifyCheckout(order.id, paymentId, signature)).toBe(true);
    await expect(g.capture(paymentId, 9_000)).rejects.toThrow("Capture amount");
    expect((await g.capture(paymentId, 10_000)).status).toBe("captured");
    await expect(g.capture(paymentId, 10_000)).rejects.toThrow("already been captured");
    const r = await g.refund(paymentId, { amountPaise: 10_000, receipt: "R1", notes: { rid: "R1" } });
    await expect(g.refund(paymentId, { amountPaise: 1, receipt: "R2" })).rejects.toThrow("greater than amount captured");
    expect((await g.refundsOf(paymentId)).map((x) => x.notes.rid)).toEqual(["R1"]);
    expect(g.settleRefund(r.id, "processed").status).toBe("processed");
    g.failNext("fetchPayment");
    await expect(g.fetchPayment(paymentId)).rejects.toMatchObject({ retryable: true });
    expect((await g.fetchPayment(paymentId)).status).toBe("captured");
    expect(g.verifyWebhook(Buffer.from("{}"), g.signWebhook("{}"))).toBe(true);
    expect(g.calls.map((c) => c.method)).toEqual(["createOrder", "capture", "capture", "capture", "refund", "refund", "refundsOf", "fetchPayment", "fetchPayment"]);
  });
});
