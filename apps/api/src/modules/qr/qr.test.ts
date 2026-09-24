import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { API_PREFIX, AuditEventSchema, PublicMenuSchema, PublicQrOrderSchema, QrOrderCreatedSchema, RAZORPAY_WEBHOOK_PATH, routes, type QrOrderCreated } from "@rch/contract";
import { customerPhoneRefusal, hoursRefusal, pausedRefusal, qrOpenAt } from "@rch/domain";
import * as s from "../../db/schema/index.js";
import { postMoves } from "../../lib/ledger.js";
import { GatewayError } from "../../lib/payments.js";
import { moveRefund, REFUND_BACKOFF_MS } from "../../lib/refunds.js";
import { buildTestApp } from "../../test/app.js";
import { BUILDER_QR_SECRET, given } from "../../test/builders.js";
import { warmPool } from "../../test/db.js";
import { createFakeGateway, type FakeGateway } from "../../test/fake-gateway.js";
import { seedTestDb } from "../../test/seed.js";
import type { App } from "../../app.js";
import { CODE_GONE, NOT_SET_UP } from "./service.js";

let app: App;
let fake: FakeGateway;
let coffee: { id: string; token: string };
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, opens: "00:00", closes: "23:59" }));

beforeAll(async () => {
  fake = createFakeGateway();
  app = await buildTestApp({ schema: "qr", payments: fake, env: { QR_ORDER_MAX_RUPEES: "1000", QR_PENDING_PER_IP: "5" } });
  await seedTestDb(app.testDb!.db);
  await app.ready();
  // Open every day at the Coffee Shop and the Restaurant; the Snack Kiosk has no hours at all.
  for (const loc of ["coffee", "rest"]) await app.db.insert(s.outletOrderHours).values(ALL_DAY.map((d) => ({ loc, ...d })));
  // Plenty on the Coffee Shop's shelf, so the cases below never run each other out.
  await app.db.transaction((tx) => postMoves(tx, ["juice", "water", "chips", "bisc"].map((it) => ({ loc: "coffee", it, qty: 400, kind: "adjustment" as const, refType: "test", refId: "qr-topup" }))));
  coffee = await given.qrCode(app.db, { loc: "coffee", label: "Table 4" });
});
afterAll(async () => { await app.close(); });

// ---- helpers. Every order comes from its own address and phone unless a case says otherwise,
// so the per-address and per-phone caps only bite the cases that are about them.
let seq = 0;
const nextIp = () => { seq += 1; return `10.20.${Math.floor(seq / 250)}.${(seq % 250) + 1}`; };
const nextPhone = () => { seq += 1; return `98${String(10_000_000 + seq).slice(-8)}`; };

type Lines = { it: string; qty: number }[];
const place = (token: string, lines: Lines, o: { ip?: string; phone?: string; nonce?: string; name?: string; detail?: string } = {}) =>
  app.inject({
    method: "POST", url: `${API_PREFIX}/public/qr/${token}/orders`, remoteAddress: o.ip ?? nextIp(),
    payload: { nonce: o.nonce ?? randomUUID(), name: o.name ?? "Asha", phone: o.phone ?? nextPhone(), lines, ...(o.detail ? { detail: o.detail } : {}) },
  });
const placed = async (lines: Lines = [{ it: "capp", qty: 2 }], token = coffee.token): Promise<QrOrderCreated> => {
  const r = await place(token, lines);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().result as QrOrderCreated;
};
const verify = (c: { order: { id: string }; secret: string; checkout: { orderId: string } }, pay = fake.pay(c.checkout.orderId), ip = nextIp()) =>
  app.inject({
    method: "POST", url: `${API_PREFIX}/public/orders/${c.order.id}/verify`, remoteAddress: ip,
    payload: { secret: c.secret, razorpay_order_id: c.checkout.orderId, razorpay_payment_id: pay.paymentId, razorpay_signature: pay.signature },
  });
const status = (id: string, k: string) => app.inject({ method: "GET", url: `${API_PREFIX}/public/orders/${id}?k=${k}`, remoteAddress: nextIp() });
const webhook = (body: unknown, o: { sig?: string; eventId?: string; raw?: string } = {}) => {
  const raw = o.raw ?? JSON.stringify(body);
  return app.inject({
    method: "POST", url: API_PREFIX + RAZORPAY_WEBHOOK_PATH, payload: raw,
    headers: { "content-type": "application/json", "x-razorpay-signature": o.sig ?? fake.signWebhook(raw), ...(o.eventId ? { "x-razorpay-event-id": o.eventId } : {}) },
  });
};
const captured = (paymentId: string) => {
  const p = fake.payments.get(paymentId)!;
  return { event: "payment.captured", payload: { payment: { entity: { id: p.id, order_id: p.orderId, amount: p.amountPaise, currency: p.currency, status: "captured", method: "upi" } } } };
};
const orderRow = async (id: string) => (await app.db.select().from(s.qrOrders).where(eq(s.qrOrders.id, id)))[0];
const billsOf = async (id: string) => app.db.select().from(s.bills).where(eq(s.bills.qrOrderId, id));
const refundsOf = async (id: string) => app.db.select().from(s.paymentRefunds).where(eq(s.paymentRefunds.qrOrderId, id)).orderBy(asc(s.paymentRefunds.id));
const onHand = async (loc: string, it: string) =>
  (await app.db.select().from(s.stockBalances).where(and(eq(s.stockBalances.loc, loc), eq(s.stockBalances.itemKey, it))))[0]?.onHand ?? 0;
const mark = async () => (await app.db.select({ id: s.auditOutbox.id }).from(s.auditOutbox).orderBy(desc(s.auditOutbox.id)).limit(1))[0]?.id ?? 0;
const eventsSince = async (m: number) =>
  (await app.db.select().from(s.auditOutbox).where(gt(s.auditOutbox.id, m)).orderBy(asc(s.auditOutbox.id))).map((r) => AuditEventSchema.parse(r.event));
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

describe("GET /public/qr/:token - the menu a code opens", () => {
  it("lists the outlet's till menu at the till's prices, capped per item, with the window and the switch", async () => {
    const r = await app.inject({ method: "GET", url: `${API_PREFIX}/public/qr/${coffee.token}` });
    expect(r.statusCode, r.body).toBe(200);
    const m = PublicMenuSchema.parse(r.json());
    expect(m.outlet).toEqual({ loc: "coffee", name: "Coffee Shop" });
    expect(m.qr).toEqual({ label: "Table 4", mode: "pickup" });
    expect(m.paused).toBe(false);
    expect(m.open.open).toBe(qrOpenAt(ALL_DAY, new Date()).open);
    const capp = m.items.find((i) => i.it === "capp")!;
    expect(capp).toMatchObject({ name: "Cappuccino", price: 75, available: true, max: 20, type: "MTO" });
    expect(m.items.map((i) => i.it).sort()).toEqual(["bisc", "capp", "chai", "chips", "juice", "water"]);
  });

  it("reads closed with the not-set-up sentence while no gateway is configured", async () => {
    const saved = app.payments;
    (app as { payments: unknown }).payments = null;
    try {
      const m = PublicMenuSchema.parse((await app.inject({ method: "GET", url: `${API_PREFIX}/public/qr/${coffee.token}` })).json());
      expect(m.open).toMatchObject({ open: false, why: NOT_SET_UP });
      expect(m.items.length).toBeGreaterThan(0);
    } finally { (app as { payments: unknown }).payments = saved; }
  });

  it("tells the customer an item is not available in one sentence, never the till's reason", async () => {
    const have = await onHand("coffee", "chips");
    await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "chips", qty: -have, kind: "adjustment", refType: "test", refId: "qr-menu-drain" }]));
    try {
      const m = PublicMenuSchema.parse((await app.inject({ method: "GET", url: `${API_PREFIX}/public/qr/${coffee.token}` })).json());
      expect(m.items.find((i) => i.it === "chips")).toMatchObject({ available: false, max: 0, why: "Not available right now." });
    } finally {
      await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "chips", qty: have, kind: "adjustment", refType: "test", refId: "qr-menu-refill" }]));
    }
  });

  it("answers an unknown code and a switched-off one with the same 404 sentence", async () => {
    const off = await given.qrCode(app.db, { loc: "coffee", active: false });
    for (const token of ["NoSuchTokenAtAllxxxxxxxx", off.token]) {
      const r = await app.inject({ method: "GET", url: `${API_PREFIX}/public/qr/${token}` });
      expect(r.statusCode).toBe(404);
      expect(r.json().error.message).toBe(CODE_GONE);
    }
    const bad = await app.inject({ method: "POST", url: `${API_PREFIX}/public/qr/${off.token}/orders`, payload: { nonce: randomUUID(), name: "A", phone: "9876543210", lines: [{ it: "capp", qty: 1 }] } });
    expect(bad.statusCode).toBe(404);
    expect(bad.json().error.message).toBe(CODE_GONE);
  });

  it("shows a closed outlet's menu as closed", async () => {
    await app.db.insert(s.locations).values({ key: "shut", name: "Old Canteen", code: "OT-OC", type: "Outlet", floor: "B1", costCentre: "CC-OC", active: false });
    const c = await given.qrCode(app.db, { loc: "shut" });
    const m = PublicMenuSchema.parse((await app.inject({ method: "GET", url: `${API_PREFIX}/public/qr/${c.token}` })).json());
    expect(m.open).toEqual({ open: false, why: "Old Canteen is closed.", today: null });
    const r = await place(c.token, [{ it: "capp", qty: 1 }]);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Old Canteen is closed - please order at the counter.");
  });
});

describe("POST /public/qr/:token/orders - placing an order", () => {
  it("quotes it, numbers it, keeps only hashes, creates the gateway's order after commit, and audits it", async () => {
    const m = await mark();
    const nonce = randomUUID();
    const r = await place(coffee.token, [{ it: "capp", qty: 2 }, { it: "juice", qty: 1 }], { nonce, phone: "+91 98765 00001", name: "Meena" });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    const c = QrOrderCreatedSchema.parse(body.result);
    expect(c.order.id).toMatch(/^QO-\d{4}-\d{4}$/);
    expect(c.order).toMatchObject({ loc: "coffee", outletName: "Coffee Shop", label: "Table 4", mode: "pickup", status: "Awaiting payment", total: 170, spot: "" });
    expect(c.order.lines).toEqual([{ it: "capp", name: "Cappuccino", qty: 2, rate: 75, amount: 150 }, { it: "juice", name: expect.any(String), qty: 1, rate: 20, amount: 20 }]);
    expect(c.order.steps).toEqual(["Paid", "Preparing", "Ready", "Collected"]);
    expect(c.checkout).toEqual({ keyId: fake.keyId, orderId: expect.any(String), amount: 17000, currency: "INR", prefill: { name: "Meena", contact: "9876500001" } });
    expect(fake.orders.get(c.checkout.orderId)).toMatchObject({ amountPaise: 17000, receipt: c.order.id });
    expect(body.changed).toEqual([]);
    expect(body.message).toBe(`Order ${c.order.id} placed - pay ₹170.00 to confirm it.`);

    const row = await orderRow(c.order.id);
    expect(row.secretHash).toBe(sha256(c.secret));
    expect(row.nonce).toBe(sha256(nonce));
    expect(row.customerPhone).toBe("9876500001");
    expect(row.rzpOrderId).toBe(c.checkout.orderId);

    const [e] = (await eventsSince(m)).filter((x) => x.action === "createQrOrder");
    expect(e).toMatchObject({ outcome: "done", target: c.order.id, targetLoc: "coffee", actor: { id: "sys-qr", name: "QR Orders" } });
    expect(JSON.stringify(e)).not.toContain(nonce);
    expect((e.request as { params: { token: string } }).params.token).toBe("••••");
  });

  it("limits the status poll per order and address, so phones sharing one Wi-Fi do not share a budget", async () => {
    const a = await placed();
    const b = await placed();
    const poll = (c: QrOrderCreated, ip: string) => app.inject({ method: "GET", url: `${API_PREFIX}/public/orders/${c.order.id}?k=${c.secret}`, remoteAddress: ip });
    const wifi = nextIp();
    for (let i = 0; i < 30; i++) expect((await poll(a, wifi)).statusCode).toBe(200);
    expect((await poll(a, wifi)).statusCode).toBe(429);
    expect((await poll(b, wifi)).statusCode).toBe(200);
    expect((await poll(a, nextIp())).statusCode).toBe(200);
  });

  it("the status page reads it with its secret, and a wrong secret is the same 404 as no order", async () => {
    const c = await placed();
    const ok = await status(c.order.id, c.secret);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(PublicQrOrderSchema.parse(ok.json()).status).toBe("Awaiting payment");
    const wrong = await status(c.order.id, "x".repeat(43));
    const none = await status("QO-2099-0001", c.secret);
    expect([wrong.statusCode, none.statusCode]).toEqual([404, 404]);
    expect(wrong.json().error.message).toBe(none.json().error.message);
  });

  it("answers a retried nonce with the same order and checkout and a fresh secret; the first secret stops working", async () => {
    const nonce = randomUUID();
    const phone = nextPhone();
    const first = (await place(coffee.token, [{ it: "capp", qty: 1 }], { nonce, phone })).json().result as QrOrderCreated;
    const again = await place(coffee.token, [{ it: "capp", qty: 1 }], { nonce, phone });
    expect(again.statusCode, again.body).toBe(200);
    const second = again.json().result as QrOrderCreated;
    expect(second.order.id).toBe(first.order.id);
    expect(second.checkout.orderId).toBe(first.checkout.orderId);
    expect(second.secret).not.toBe(first.secret);
    expect((await status(first.order.id, first.secret)).statusCode).toBe(404);
    expect((await status(first.order.id, second.secret)).statusCode).toBe(200);
    expect(again.json().message).toBe(`Order ${first.order.id} is already placed - pay ₹75.00 to confirm it.`);
  });

  it("two requests with one nonce at once place one order", async () => {
    await warmPool(app.testDb!, 2);
    const nonce = randomUUID();
    const phone = nextPhone();
    const [a, b] = await Promise.all([place(coffee.token, [{ it: "capp", qty: 1 }], { nonce, phone }), place(coffee.token, [{ it: "capp", qty: 1 }], { nonce, phone })]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().result.order.id).toBe(b.json().result.order.id);
    expect(await app.db.select().from(s.qrOrders).where(eq(s.qrOrders.nonce, sha256(nonce)))).toHaveLength(1);
  });

  it("refuses a spent nonce once its order is paid, and one from another code", async () => {
    const nonce = randomUUID();
    const phone = nextPhone();
    const c = (await place(coffee.token, [{ it: "capp", qty: 1 }], { nonce, phone })).json().result as QrOrderCreated;
    const other = await given.qrCode(app.db, { loc: "coffee" });
    const moved = await place(other.token, [{ it: "capp", qty: 1 }], { nonce, phone });
    expect(moved.statusCode).toBe(409);
    expect((await verify(c)).statusCode).toBe(200);
    const spent = await place(coffee.token, [{ it: "capp", qty: 1 }], { nonce, phone });
    expect(spent.statusCode).toBe(409);
    expect(spent.json().error.message).toBe(`Order ${c.order.id} has already been placed and paid - open its status page to follow it.`);
  });

  it("refuses a phone that is not one, in the customer's words", async () => {
    const r = await place(coffee.token, [{ it: "capp", qty: 1 }], { phone: "12345" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(customerPhoneRefusal("12345"));
  });

  it("refuses outside the outlet's hours, and while the counter has paused it", async () => {
    const kiosk = await given.qrCode(app.db, { loc: "kiosk" });
    const closed = await place(kiosk.token, [{ it: "chips", qty: 1 }]);
    expect(closed.statusCode).toBe(422);
    expect(closed.json().error.message).toBe(hoursRefusal("Snack Kiosk", qrOpenAt([], new Date())));

    const rest = await given.qrCode(app.db, { loc: "rest" });
    await app.db.insert(s.qrOutletState).values({ loc: "rest", paused: true });
    const paused = await place(rest.token, [{ it: "capp", qty: 1 }]);
    expect(paused.statusCode).toBe(422);
    expect(paused.json().error.message).toBe(pausedRefusal("Restaurant"));
    const m = PublicMenuSchema.parse((await app.inject({ method: "GET", url: `${API_PREFIX}/public/qr/${rest.token}` })).json());
    expect(m.paused).toBe(true);
    await app.db.delete(s.qrOutletState).where(eq(s.qrOutletState.loc, "rest"));
  });

  it("holds an order to the deployment's rupee cap and one item to twenty units", async () => {
    const big = await place(coffee.token, [{ it: "capp", qty: 14 }]);
    expect(big.statusCode).toBe(422);
    expect(big.json().error.message).toBe("One QR order can come to at most ₹1,000.00 - this one is ₹1,050.00. Take a few items off, or order at the counter.");
    const split = await place(coffee.token, [{ it: "chai", qty: 15 }, { it: "chai", qty: 10 }]);
    expect(split.statusCode).toBe(422);
    expect(split.json().error.message).toBe("One order can carry at most 20 of Masala tea.");
  });

  it("refuses an order under the gateway's ₹1 minimum", async () => {
    await app.db.update(s.priceListItems).set({ price: 0.5 }).where(and(eq(s.priceListItems.listId, "PL-002"), eq(s.priceListItems.itemKey, "water")));
    try {
      const r = await place(coffee.token, [{ it: "water", qty: 1 }]);
      expect(r.statusCode).toBe(422);
      expect(r.json().error.message).toBe("An online payment has to be at least ₹1.00 - this order is ₹0.50. Add an item, or order at the counter.");
      expect((await place(coffee.token, [{ it: "water", qty: 2 }])).statusCode).toBe(200);
    } finally {
      await app.db.update(s.priceListItems).set({ price: 20 }).where(and(eq(s.priceListItems.listId, "PL-002"), eq(s.priceListItems.itemKey, "water")));
    }
  });

  it("refuses what the till would refuse - an item not on this outlet's menu", async () => {
    const r = await place(coffee.token, [{ it: "sand", qty: 1 }]);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/is not listed at Coffee Shop$/);
  });

  it("lets one phone hold three unpaid orders, and one address the deployment's QR_PENDING_PER_IP (five here) in half an hour", async () => {
    const phone = nextPhone();
    for (let i = 0; i < 3; i++) expect((await place(coffee.token, [{ it: "capp", qty: 1 }], { phone })).statusCode).toBe(200);
    const fourth = await place(coffee.token, [{ it: "capp", qty: 1 }], { phone });
    expect(fourth.statusCode).toBe(422);
    expect(fourth.json().error.message).toBe("You already have 3 unpaid orders - pay for one, or let it lapse, before placing another.");
    // Hospital-wide: the same phone at another outlet is refused too.
    const rest = await given.qrCode(app.db, { loc: "rest", label: "Table 1" });
    const elsewhere = await place(rest.token, [{ it: "capp", qty: 1 }], { phone });
    expect(elsewhere.statusCode).toBe(422);
    expect(elsewhere.json().error.message).toBe(fourth.json().error.message);

    const ip = nextIp();
    for (let i = 0; i < 5; i++) expect((await place(coffee.token, [{ it: "capp", qty: 1 }], { ip })).statusCode).toBe(200);
    const sixth = await place(coffee.token, [{ it: "capp", qty: 1 }], { ip });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.message).toBe("Too many unpaid orders from this connection - pay for one, or try again in a few minutes.");
  });

  it("answers 503 while the gateway is not configured, and 503 when it cannot be reached - the retry then goes through", async () => {
    const saved = app.payments;
    (app as { payments: unknown }).payments = null;
    try {
      const off = await place(coffee.token, [{ it: "capp", qty: 1 }]);
      expect(off.statusCode).toBe(503);
      expect(off.json().error.message).toBe(NOT_SET_UP);
    } finally { (app as { payments: unknown }).payments = saved; }

    const nonce = randomUUID();
    const phone = nextPhone();
    fake.failNext("createOrder");
    const down = await place(coffee.token, [{ it: "capp", qty: 1 }], { nonce, phone });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.message).toBe("We could not reach the payment service - try again in a moment.");
    const retry = await place(coffee.token, [{ it: "capp", qty: 1 }], { nonce, phone });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(fake.orders.get(retry.json().result.checkout.orderId)).toBeTruthy();
  });

  it("says online payment is unavailable when the gateway refuses the checkout, and lapses that order so it counts toward no cap", async () => {
    const ip = nextIp();
    const phone = nextPhone();
    for (let i = 0; i < 6; i++) {
      fake.failNext("createOrder", new GatewayError("Authentication failed", 401, "BAD_REQUEST_ERROR", false));
      const r = await place(coffee.token, [{ it: "capp", qty: 1 }], { ip, phone });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.message).toBe("Online payment is not available right now - please order at the counter.");
    }
    const lapsed = await app.db.select().from(s.qrOrders).where(eq(s.qrOrders.ip, ip));
    expect(lapsed).toHaveLength(6);
    expect(lapsed.every((o) => o.status === "Expired" && o.rzpOrderId === null)).toBe(true);
    // Six refusals later, the same phone and address still place an order.
    expect((await place(coffee.token, [{ it: "capp", qty: 1 }], { ip, phone })).statusCode).toBe(200);
  });
});

describe("capture - POST /public/orders/:id/verify", () => {
  it("bills a captured payment as the QR Orders account with the Online tender, and audits it", async () => {
    const before = await onHand("coffee", "juice");
    const c = await placed([{ it: "juice", qty: 2 }, { it: "capp", qty: 1 }]);
    const m = await mark();
    const r = await verify(c);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    const o = PublicQrOrderSchema.parse(body.result);
    expect(o.status).toBe("Paid");
    expect(o.billNo).toMatch(/^CF\//);
    expect(body.changed).toEqual(["stock", "bills", "qrOrders"]);

    const [bill] = await billsOf(c.order.id);
    expect(bill).toMatchObject({ operatorId: "sys-qr", tender: "Online", source: "qr", loc: "coffee", total: 115, customerName: "Asha" });
    expect(await onHand("coffee", "juice")).toBe(before - 2);
    const row = await orderRow(c.order.id);
    expect(row).toMatchObject({ status: "Paid", billNo: bill.no, rzpPaymentId: expect.any(String) });
    expect(row.paidAt).toBeTruthy();
    const e = (await eventsSince(m)).find((x) => x.action === "qrOrderPaid")!;
    expect(e).toMatchObject({ target: c.order.id, targetLoc: "coffee", actor: { id: "sys-qr" }, path: routes.verifyQrPayment.path });
    expect(e.message).toBe(`Order ${c.order.id} paid online - bill ${bill.no} · ₹115.00 at Coffee Shop`);
  });

  it("is idempotent - the same payment verified again makes no second bill", async () => {
    const c = await placed();
    const pay = fake.pay(c.checkout.orderId);
    expect((await verify(c, pay)).statusCode).toBe(200);
    const again = await verify(c, pay);
    expect(again.statusCode).toBe(200);
    expect(again.json().changed).toEqual([]);
    expect(await billsOf(c.order.id)).toHaveLength(1);
  });

  it("captures a payment that is only authorised", async () => {
    const c = await placed();
    const pay = fake.pay(c.checkout.orderId, { status: "authorized" });
    const r = await verify(c, pay);
    expect(r.statusCode, r.body).toBe(200);
    expect(fake.payments.get(pay.paymentId)!.status).toBe("captured");
    expect(r.json().result.status).toBe("Paid");
  });

  it("refuses a failed payment, a bad signature, another order's payment and a wrong secret", async () => {
    const c = await placed();
    const failed = await verify(c, fake.pay(c.checkout.orderId, { status: "failed" }));
    expect(failed.statusCode).toBe(422);
    expect(failed.json().error.message).toBe("The payment did not go through - you have not been charged. Tap Pay to try again.");

    const pay = fake.pay(c.checkout.orderId);
    const forged = await verify(c, { paymentId: pay.paymentId, signature: "0".repeat(64) });
    expect(forged.statusCode).toBe(400);

    const other = await placed();
    const cross = await verify({ ...c, checkout: other.checkout }, fake.pay(other.checkout.orderId));
    expect(cross.statusCode).toBe(400);
    expect(cross.json().error.message).toBe(`This payment is not for order ${c.order.id}.`);

    const noSecret = await verify({ ...c, secret: "y".repeat(43) }, pay);
    expect(noSecret.statusCode).toBe(404);
    expect(await billsOf(c.order.id)).toHaveLength(0);
  });

  it("answers 503 when the gateway cannot be asked about the payment, so the page waits for the webhook", async () => {
    const c = await placed();
    const pay = fake.pay(c.checkout.orderId);
    fake.failNext("fetchPayment");
    const r = await verify(c, pay);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.message).toBe("We could not confirm your payment yet - this page will update as soon as it goes through.");
  });

  it("refunds instead of billing when an item sold out between the order and the payment", async () => {
    const c = await placed([{ it: "chips", qty: 2 }]);
    const have = await onHand("coffee", "chips");
    await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "chips", qty: -have, kind: "adjustment", refType: "test", refId: "qr-drain" }]));
    const m = await mark();
    const r = await verify(c);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.status).toBe("Refunded");
    expect(r.json().result.refund).toEqual({ status: "Pending", amount: 40 });
    expect(await billsOf(c.order.id)).toHaveLength(0);
    expect(await onHand("coffee", "chips")).toBe(0);
    const [refund] = await refundsOf(c.order.id);
    expect(refund).toMatchObject({ id: `${c.order.id}-R1`, reason: "unfulfillable", status: "Pending", amount: 40, billNo: null });
    const e = (await eventsSince(m)).find((x) => x.action === "qrOrderRefunded")!;
    expect(e.message).toBe(`Order ${c.order.id} could not be filled - Salted chips 52g is not available at Coffee Shop - zero at this location - so ₹40.00 is being refunded (${refund.id})`);
    const hist = await app.db.select().from(s.documentHistory).where(and(eq(s.documentHistory.docType, "qr_order"), eq(s.documentHistory.docId, c.order.id)));
    expect(hist.map((h) => h.status)).toEqual(["Awaiting payment", "Refunded - Salted chips 52g is not available at Coffee Shop - zero at this location"]);
    await app.db.transaction((tx) => postMoves(tx, [{ loc: "coffee", it: "chips", qty: 400, kind: "adjustment", refType: "test", refId: "qr-refill" }]));
  });

  it("refunds when the price moved after the quote, and when the amount paid does not match", async () => {
    const c = await placed([{ it: "water", qty: 1 }]);
    await app.db.update(s.priceListItems).set({ price: 18 }).where(and(eq(s.priceListItems.listId, "PL-002"), eq(s.priceListItems.itemKey, "water")));
    try {
      const r = await verify(c);
      expect(r.json().result.status).toBe("Refunded");
      expect((await orderRow(c.order.id)).status).toBe("Refunded");
      expect(await billsOf(c.order.id)).toHaveLength(0);
    } finally {
      await app.db.update(s.priceListItems).set({ price: 20 }).where(and(eq(s.priceListItems.listId, "PL-002"), eq(s.priceListItems.itemKey, "water")));
    }
    const d = await placed([{ it: "capp", qty: 1 }]);
    const short = fake.pay(d.checkout.orderId, { amountPaise: 100 });
    const r = await webhook(captured(short.paymentId));
    expect(r.statusCode).toBe(200);
    const row = await orderRow(d.order.id);
    expect(row.status).toBe("Refunded");
    const [refund] = await refundsOf(d.order.id);
    expect(refund).toMatchObject({ amount: 1, reason: "unfulfillable" });
  });

  it("refunds a second payment against an order already paid, as a duplicate, once", async () => {
    const c = await placed();
    expect((await verify(c)).statusCode).toBe(200);
    const second = fake.pay(c.checkout.orderId);
    expect((await webhook(captured(second.paymentId))).statusCode).toBe(200);
    expect((await webhook(captured(second.paymentId))).statusCode).toBe(200);
    const refunds = await refundsOf(c.order.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ reason: "duplicate", paymentId: second.paymentId, amount: 150 });
    expect((await orderRow(c.order.id)).status).toBe("Paid");
    expect(await billsOf(c.order.id)).toHaveLength(1);
  });

  it("puts a capture off while a Z is closing the register - no bill, no refund - and bills it on the next try", async () => {
    const c = await placed([{ it: "juice", qty: 1 }]);
    const pay = fake.pay(c.checkout.orderId);
    // A Z that closes the session and wins every race after: no open session, and none can open.
    await app.db.update(s.registerSessions).set({ closedAt: new Date(), zNo: `Z-QR-${randomUUID().slice(0, 8)}` })
      .where(and(eq(s.registerSessions.loc, "coffee"), isNull(s.registerSessions.closedAt)));
    await app.db.execute(sql.raw(`create function qr_z_race() returns trigger language plpgsql as $$ begin return null; end $$;
      create trigger qr_z_race before insert on register_sessions for each row execute function qr_z_race()`));
    try {
      const v = await verify(c, pay);
      expect(v.statusCode, v.body).toBe(503);
      expect(v.json().error.message).toBe("We could not confirm your payment yet - this page will update as soon as it goes through.");
      const w = await webhook(captured(pay.paymentId), { eventId: `evt_${randomUUID()}` });
      expect(w.statusCode).toBe(503);
      expect(await billsOf(c.order.id)).toHaveLength(0);
      expect(await refundsOf(c.order.id)).toHaveLength(0);
      expect((await orderRow(c.order.id)).status).toBe("Awaiting payment");
    } finally {
      await app.db.execute(sql.raw("drop trigger qr_z_race on register_sessions; drop function qr_z_race()"));
    }
    const again = await verify(c, pay);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().result.status).toBe("Paid");
    expect(await billsOf(c.order.id)).toHaveLength(1);
  });

  it("a verify and a webhook arriving together make exactly one bill", async () => {
    for (let round = 0; round < 3; round++) {
      const c = await placed([{ it: "juice", qty: 1 }]);
      const pay = fake.pay(c.checkout.orderId);
      await warmPool(app.testDb!, 3);
      const [v, w] = await Promise.all([verify(c, pay), webhook(captured(pay.paymentId))]);
      expect([v.statusCode, w.statusCode]).toEqual([200, 200]);
      expect(await billsOf(c.order.id)).toHaveLength(1);
      expect(await refundsOf(c.order.id)).toHaveLength(0);
      expect((await orderRow(c.order.id)).status).toBe("Paid");
    }
  });
});

describe(`POST ${RAZORPAY_WEBHOOK_PATH} - the gateway's webhook`, () => {
  it("is not a manifest route", () => {
    expect(Object.values(routes).some((r) => r.path === RAZORPAY_WEBHOOK_PATH)).toBe(false);
    expect(app.hasRoute({ method: "POST", url: API_PREFIX + RAZORPAY_WEBHOOK_PATH })).toBe(true);
  });

  it("answers 401 to a signature that does not match, and 400 to a signed body that is not JSON", async () => {
    const forged = await webhook({ event: "payment.captured" }, { sig: "0".repeat(64) });
    expect(forged.statusCode).toBe(401);
    const unsigned = await app.inject({ method: "POST", url: API_PREFIX + RAZORPAY_WEBHOOK_PATH, payload: "{}", headers: { "content-type": "application/json" } });
    expect(unsigned.statusCode).toBe(401);
    const junk = await webhook(null, { raw: "{not json" });
    expect(junk.statusCode).toBe(400);
    const text = await app.inject({ method: "POST", url: API_PREFIX + RAZORPAY_WEBHOOK_PATH, payload: "{}", headers: { "content-type": "text/plain", "x-razorpay-signature": fake.signWebhook("{}") } });
    expect(text.statusCode).toBe(415);
  });

  it("settles a payment on its own - no verify from the browser at all", async () => {
    const c = await placed();
    const pay = fake.pay(c.checkout.orderId);
    const m = await mark();
    const r = await webhook(captured(pay.paymentId), { eventId: `evt_${randomUUID()}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect((await orderRow(c.order.id)).status).toBe("Paid");
    expect((await eventsSince(m)).find((e) => e.action === "qrOrderPaid")).toMatchObject({ path: RAZORPAY_WEBHOOK_PATH });
    // `order.paid` carries the same payment, and finds it settled.
    const p = captured(pay.paymentId).payload.payment;
    expect((await webhook({ event: "order.paid", payload: { payment: p, order: { entity: { id: c.checkout.orderId } } } })).statusCode).toBe(200);
    expect(await billsOf(c.order.id)).toHaveLength(1);
  });

  it("captures and bills a payment.authorized on its own, and one captured meanwhile is still billed once", async () => {
    const c = await placed();
    const pay = fake.pay(c.checkout.orderId, { status: "authorized" });
    const authorized = (id: string) => {
      const e = captured(id);
      return { event: "payment.authorized", payload: { payment: { entity: { ...e.payload.payment.entity, status: "authorized" } } } };
    };
    const r = await webhook(authorized(pay.paymentId), { eventId: `evt_${randomUUID()}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(fake.payments.get(pay.paymentId)!.status).toBe("captured");
    expect((await orderRow(c.order.id)).status).toBe("Paid");
    expect(await billsOf(c.order.id)).toHaveLength(1);
    // Redelivered after the capture: the gateway refuses a second capture, the payment is read
    // back, and the same payment settles nothing twice.
    expect((await webhook(authorized(pay.paymentId))).statusCode).toBe(200);
    expect(await billsOf(c.order.id)).toHaveLength(1);
    expect(await refundsOf(c.order.id)).toHaveLength(0);

    // The gateway cannot be reached for the capture: 503, and the redelivery settles it.
    const d = await placed();
    const payD = fake.pay(d.checkout.orderId, { status: "authorized" });
    fake.failNext("capture");
    expect((await webhook(authorized(payD.paymentId))).statusCode).toBe(503);
    expect((await orderRow(d.order.id)).status).toBe("Awaiting payment");
    expect((await webhook(authorized(payD.paymentId))).statusCode).toBe(200);
    expect((await orderRow(d.order.id)).status).toBe("Paid");
  });

  it("drops a delivery it has already handled, and acknowledges an event it does not use", async () => {
    const c = await placed();
    const pay = fake.pay(c.checkout.orderId);
    const eventId = `evt_${randomUUID()}`;
    expect((await webhook(captured(pay.paymentId), { eventId })).json()).toEqual({ ok: true });
    expect((await webhook(captured(pay.paymentId), { eventId })).json()).toEqual({ ok: true, duplicate: true });
    const other = await webhook({ event: "payment.failed", payload: {} }, { eventId: `evt_${randomUUID()}` });
    expect(other.statusCode).toBe(200);
    const stranger = await webhook({ event: "payment.captured", payload: { payment: { entity: { id: "pay_x", order_id: "order_unknown", amount: 100, currency: "INR", status: "captured" } } } });
    expect(stranger.statusCode).toBe(200);
  });
});

describe("the worker", () => {
  const unfulfillable = async () => {
    const c = await placed([{ it: "capp", qty: 1 }]);
    const pay = fake.pay(c.checkout.orderId, { amountPaise: 7400 });
    await webhook(captured(pay.paymentId));
    const [r] = await refundsOf(c.order.id);
    return { c, pay, r };
  };
  /** Only these refunds due: every other Pending refund the file queued is put far off. */
  const only = async (id: string) => {
    await app.db.update(s.paymentRefunds).set({ nextAttemptAt: new Date(Date.now() + 86_400_000 * 365) }).where(eq(s.paymentRefunds.status, "Pending"));
    await app.db.update(s.paymentRefunds).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(s.paymentRefunds.id, id));
  };

  it("expires unpaid orders past their window, and a late capture still bills", async () => {
    const [gw] = [await fake.createOrder({ amountPaise: 7500, receipt: "late" })];
    const id = await given.qrOrder(app.db, { loc: "coffee", code: coffee.id, lines: [{ it: "capp", qty: 1, rate: 75 }], rzpOrderId: gw.id, expiresAt: new Date(Date.now() - 60_000) });
    const t = await app.qrWorker.tick();
    expect(t.expired).toBeGreaterThanOrEqual(1);
    expect((await orderRow(id)).status).toBe("Expired");
    const r = await verify({ order: { id }, secret: BUILDER_QR_SECRET, checkout: { orderId: gw.id } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.status).toBe("Paid");
    expect(await billsOf(id)).toHaveLength(1);
  });

  it("sends a queued refund with its id in the notes, then the gateway's webhook finishes it", async () => {
    const { pay, r } = await unfulfillable();
    await only(r.id);
    const m = await mark();
    const t = await app.qrWorker.tick();
    expect(t).toMatchObject({ sent: 1, deferred: 0, failed: 0 });
    const sentRefund = fake.refunds.find((x) => x.notes.rid === r.id)!;
    expect(sentRefund).toMatchObject({ paymentId: pay.paymentId, amountPaise: 7400, receipt: r.id });
    const [row] = await app.db.select().from(s.paymentRefunds).where(eq(s.paymentRefunds.id, r.id));
    expect(row).toMatchObject({ status: "Sent", rzpRefundId: sentRefund.id, attempts: 1 });

    const done = fake.settleRefund(sentRefund.id, "processed");
    const w = await webhook({ event: "refund.processed", payload: { refund: { entity: { id: done.id, payment_id: done.paymentId, notes: done.notes, status: "processed" } } } });
    expect(w.statusCode).toBe(200);
    const [after] = await app.db.select().from(s.paymentRefunds).where(eq(s.paymentRefunds.id, r.id));
    expect(after.status).toBe("Processed");
    expect(after.processedAt).toBeTruthy();
    expect((await eventsSince(m)).map((e) => e.action)).toEqual(["qrRefundSent", "qrRefundProcessed"]);
  });

  it("never refunds twice: a send whose answer was lost is found at the gateway by its notes id", async () => {
    const { pay, r } = await unfulfillable();
    await only(r.id);
    await fake.refund(pay.paymentId, { amountPaise: 7400, receipt: r.id, notes: { rid: r.id } });
    const sends = fake.calls.filter((c) => c.method === "refund").length;
    expect((await app.qrWorker.tick()).sent).toBe(1);
    expect(fake.calls.filter((c) => c.method === "refund").length).toBe(sends);
    expect(fake.refunds.filter((x) => x.notes.rid === r.id)).toHaveLength(1);
  });

  it("backs off after a failed send, and fails the refund after the sixth", async () => {
    const { r } = await unfulfillable();
    await only(r.id);
    const t0 = Date.now();
    fake.failNext("refundsOf");
    expect((await app.qrWorker.tick(new Date(t0))).deferred).toBe(1);
    const [one] = await app.db.select().from(s.paymentRefunds).where(eq(s.paymentRefunds.id, r.id));
    expect(one).toMatchObject({ status: "Pending", attempts: 1, lastError: "The payment gateway could not be reached" });
    expect(one.nextAttemptAt.getTime()).toBe(t0 + REFUND_BACKOFF_MS[0]);
    // Not due yet: a pass a moment later leaves it alone.
    expect((await app.qrWorker.tick(new Date(t0 + 1000))).deferred).toBe(0);

    const m = await mark();
    let at = t0;
    for (let i = 1; i < 6; i++) {
      at += REFUND_BACKOFF_MS[i - 1];
      fake.failNext("refundsOf");
      await app.qrWorker.tick(new Date(at));
    }
    const [failed] = await app.db.select().from(s.paymentRefunds).where(eq(s.paymentRefunds.id, r.id));
    expect(failed).toMatchObject({ status: "Failed", attempts: 6 });
    expect((await eventsSince(m)).filter((e) => e.action === "qrRefundFailed")).toHaveLength(1);
  });

  it("fails at once on a refusal the gateway will repeat, and a refund.failed webhook fails a sent one", async () => {
    const a = await unfulfillable();
    await only(a.r.id);
    fake.failNext("refund", new GatewayError("The refund amount provided is greater than amount captured", 400, "BAD_REQUEST_ERROR", false));
    expect((await app.qrWorker.tick()).failed).toBe(1);
    const [fa] = await app.db.select().from(s.paymentRefunds).where(eq(s.paymentRefunds.id, a.r.id));
    expect(fa).toMatchObject({ status: "Failed", lastError: "The refund amount provided is greater than amount captured" });

    const b = await unfulfillable();
    await only(b.r.id);
    await app.qrWorker.tick();
    const g = fake.refunds.find((x) => x.notes.rid === b.r.id)!;
    const w = await webhook({ event: "refund.failed", payload: { refund: { entity: { id: g.id, payment_id: g.paymentId, notes: g.notes, status: "failed" } } } });
    expect(w.statusCode).toBe(200);
    const [fb] = await app.db.select().from(s.paymentRefunds).where(eq(s.paymentRefunds.id, b.r.id));
    expect(fb.status).toBe("Failed");
  });

  it("ignores a late refund.failed for a first send once the refund was retried and sent again", async () => {
    const { r } = await unfulfillable();
    await only(r.id);
    await app.qrWorker.tick(undefined, { reconcile: false });
    const g1 = fake.refunds.find((x) => x.notes.rid === r.id)!;
    const failed1 = () => {
      const g = fake.refunds.find((x) => x.id === g1.id)!;
      return { event: "refund.failed", payload: { refund: { entity: { id: g.id, payment_id: g.paymentId, notes: g.notes, status: "failed" } } } };
    };
    fake.settleRefund(g1.id, "failed");
    expect((await webhook(failed1())).statusCode).toBe(200);
    expect((await refundsOf(r.qrOrderId))[0]).toMatchObject({ status: "Failed", rzpRefundId: g1.id });

    // The manager's retry (the route's own move) forgets the failed send.
    await app.db.transaction((tx) => moveRefund(tx, r.id, "Pending"));
    expect((await refundsOf(r.qrOrderId))[0]).toMatchObject({ status: "Pending", rzpRefundId: null });
    await only(r.id);
    await app.qrWorker.tick(undefined, { reconcile: false });
    const g2 = fake.refunds.find((x) => x.notes.rid === r.id && x.id !== g1.id)!;
    expect((await refundsOf(r.qrOrderId))[0]).toMatchObject({ status: "Sent", rzpRefundId: g2.id });

    // R1's failure delivered again: the row is R2's now, and stays Sent.
    expect((await webhook(failed1())).statusCode).toBe(200);
    expect((await refundsOf(r.qrOrderId))[0]).toMatchObject({ status: "Sent", rzpRefundId: g2.id });
  });

  it("records a refund the gateway settled on the spot as processed, and leaves refunds alone with no gateway", async () => {
    const { r } = await unfulfillable();
    await only(r.id);
    const saved = app.payments;
    (app as { payments: unknown }).payments = null;
    try {
      expect(await app.qrWorker.tick()).toMatchObject({ sent: 0, deferred: 0, failed: 0 });
    } finally { (app as { payments: unknown }).payments = saved; }
    fake.refundStatus = "processed";
    try {
      expect((await app.qrWorker.tick()).sent).toBe(1);
    } finally { fake.refundStatus = "pending"; }
    const [row] = await app.db.select().from(s.paymentRefunds).where(eq(s.paymentRefunds.id, r.id));
    expect(row.status).toBe("Processed");
  });
});

// Last in the file: a reconcile pass looks at every order the file placed, not only its own.
describe("the worker's reconcile pass", () => {
  const later = (ms: number) => new Date(Date.now() + ms);

  it("bills a payment whose tab closed and whose webhook was lost, and captures one only authorised", async () => {
    const a = await placed([{ it: "juice", qty: 1 }]);
    fake.pay(a.checkout.orderId);
    const b = await placed([{ it: "juice", qty: 1 }]);
    const authorised = fake.pay(b.checkout.orderId, { status: "authorized" });
    // Too young to ask about: the phone's own verify may still be on its way.
    expect((await app.qrWorker.tick(undefined, { reconcile: true })).reconciled).toBe(0);
    expect((await orderRow(a.order.id)).status).toBe("Awaiting payment");

    const m = await mark();
    const t = await app.qrWorker.tick(later(3 * 60_000), { reconcile: true });
    expect(t.reconciled).toBeGreaterThanOrEqual(2);
    for (const c of [a, b]) {
      expect((await orderRow(c.order.id)).status).toBe("Paid");
      expect(await billsOf(c.order.id)).toHaveLength(1);
    }
    expect(fake.payments.get(authorised.paymentId)!.status).toBe("captured");
    expect((await eventsSince(m)).filter((e) => e.action === "qrOrderPaid" && [a.order.id, b.order.id].includes(e.target))).toHaveLength(2);
    // Asked about again only after its backoff, and settled once however often it is asked.
    const asked = fake.calls.filter((c) => c.method === "paymentsOfOrder" && c.args[0] === a.checkout.orderId).length;
    await app.qrWorker.tick(later(4 * 60_000), { reconcile: true });
    expect(fake.calls.filter((c) => c.method === "paymentsOfOrder" && c.args[0] === a.checkout.orderId).length).toBe(asked);
    expect(await billsOf(a.order.id)).toHaveLength(1);
  });

  it("bills an order that lapsed before its lost payment was found, and leaves one the gateway cannot answer for later", async () => {
    const gw = await fake.createOrder({ amountPaise: 7500, receipt: "lapsed" });
    const id = await given.qrOrder(app.db, { loc: "coffee", code: coffee.id, lines: [{ it: "capp", qty: 1, rate: 75 }], rzpOrderId: gw.id, expiresAt: new Date(Date.now() - 60_000) });
    await app.db.update(s.qrOrders).set({ createdAt: new Date(Date.now() - 40 * 60_000) }).where(eq(s.qrOrders.id, id));
    await app.qrWorker.tick();
    expect((await orderRow(id)).status).toBe("Expired");
    fake.pay(gw.id);
    const real = fake.paymentsOfOrder;
    fake.paymentsOfOrder = async (o) => { if (o === gw.id) throw new GatewayError("The payment gateway could not be reached", 0, "network", true); return real(o); };
    try {
      await app.qrWorker.tick(later(10 * 60_000), { reconcile: true });
    } finally { fake.paymentsOfOrder = real; }
    expect((await orderRow(id)).status).toBe("Expired");
    await app.qrWorker.tick(later(60 * 60_000), { reconcile: true });
    expect((await orderRow(id)).status).toBe("Paid");
    expect(await billsOf(id)).toHaveLength(1);
  });

  it("moves a Sent refund whose webhook never came to Processed, or Failed, by asking the gateway", async () => {
    const mk = async () => {
      const c = await placed([{ it: "capp", qty: 1 }]);
      const pay = fake.pay(c.checkout.orderId, { amountPaise: 7400 });
      await webhook(captured(pay.paymentId));
      const [r] = await refundsOf(c.order.id);
      return r;
    };
    const ok = await mk();
    const bad = await mk();
    await app.qrWorker.tick(undefined, { reconcile: false });
    const gOk = fake.refunds.find((x) => x.notes.rid === ok.id)!;
    const gBad = fake.refunds.find((x) => x.notes.rid === bad.id)!;
    for (const r of [ok, bad]) expect((await refundsOf(r.qrOrderId))[0].status).toBe("Sent");
    fake.settleRefund(gOk.id, "processed");
    fake.settleRefund(gBad.id, "failed");
    // Not yet half an hour since it was sent: nobody asks.
    await app.qrWorker.tick(later(60_000), { reconcile: true });
    expect((await refundsOf(ok.qrOrderId))[0].status).toBe("Sent");

    const m = await mark();
    const t = await app.qrWorker.tick(later(31 * 60_000), { reconcile: true });
    expect(t.polled).toBeGreaterThanOrEqual(2);
    expect((await refundsOf(ok.qrOrderId))[0]).toMatchObject({ status: "Processed" });
    expect((await refundsOf(bad.qrOrderId))[0]).toMatchObject({ status: "Failed" });
    const actions = (await eventsSince(m)).filter((e) => [ok.id, bad.id].includes(e.target)).map((e) => e.action).sort();
    expect(actions).toEqual(["qrRefundFailed", "qrRefundProcessed"]);
  });
});
