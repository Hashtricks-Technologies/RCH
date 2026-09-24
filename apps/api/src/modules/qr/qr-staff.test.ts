import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, desc, eq, gt } from "drizzle-orm";
import { AdminQrCodesResponseSchema, API_PREFIX, AuditEventSchema, BillSchema, QrOrderSchema, QrOrdersResponseSchema, RegisterReportSchema, type QrOrderCreated } from "@rch/contract";
import * as s from "../../db/schema/index.js";
import { buildApp, type App } from "../../app.js";
import { postMoves } from "../../lib/ledger.js";
import { buildTestApp, testConfig } from "../../test/app.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { createFakeGateway, type FakeGateway } from "../../test/fake-gateway.js";
import { seedTestDb } from "../../test/seed.js";
import { CODE_GONE } from "./service.js";

let app: App;
let fake: FakeGateway;
let coffee: { id: string; token: string };
let kioskCode: { id: string; token: string };
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, opens: "00:00", closes: "23:59" }));

beforeAll(async () => {
  fake = createFakeGateway();
  app = await buildTestApp({ schema: "qrstaff", payments: fake });
  await seedTestDb(app.testDb!.db);
  await app.ready();
  for (const loc of ["coffee", "kiosk"]) await app.db.insert(s.outletOrderHours).values(ALL_DAY.map((d) => ({ loc, ...d })));
  await app.db.transaction((tx) => postMoves(tx, ["juice", "water", "chips"].map((it) => ({ loc: "coffee", it, qty: 200, kind: "adjustment" as const, refType: "test", refId: "qr-topup" }))));
  coffee = await given.qrCode(app.db, { loc: "coffee", label: "Table 4" });
  kioskCode = await given.qrCode(app.db, { loc: "kiosk", label: "Bench", mode: "deliver" });
});
afterAll(async () => { await app.close(); });

let seq = 0;
const nextIp = () => { seq += 1; return `10.30.${Math.floor(seq / 250)}.${(seq % 250) + 1}`; };
const nextPhone = () => { seq += 1; return `97${String(10_000_000 + seq).slice(-8)}`; };

/** A paid order, through the customer's own routes: placed, paid at the fake gateway, verified. */
async function paidOrder(token = coffee.token, lines = [{ it: "juice", qty: 1 }], detail?: string): Promise<{ id: string; billNo: string; created: QrOrderCreated }> {
  const r = await app.inject({
    method: "POST", url: `${API_PREFIX}/public/qr/${token}/orders`, remoteAddress: nextIp(),
    payload: { nonce: randomUUID(), name: "Ravi", phone: nextPhone(), lines, ...(detail ? { detail } : {}) },
  });
  expect(r.statusCode, r.body).toBe(200);
  const created = r.json().result as QrOrderCreated;
  const pay = fake.pay(created.checkout.orderId);
  const v = await app.inject({
    method: "POST", url: `${API_PREFIX}/public/orders/${created.order.id}/verify`, remoteAddress: nextIp(),
    payload: { secret: created.secret, razorpay_order_id: created.checkout.orderId, razorpay_payment_id: pay.paymentId, razorpay_signature: pay.signature },
  });
  expect(v.statusCode, v.body).toBe(200);
  return { id: created.order.id, billNo: v.json().result.billNo as string, created };
}

const as = async (user: string, method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) =>
  app.inject({
    method, url: API_PREFIX + url, payload: payload as never,
    headers: { ...(await authHeaders(app, user)), ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }) },
  });
const queue = async (user: string) => {
  const r = await as(user, "GET", "/qr-orders");
  expect(r.statusCode, r.body).toBe(200);
  return QrOrdersResponseSchema.parse(r.json());
};
const mark = async () => (await app.db.select({ id: s.auditOutbox.id }).from(s.auditOutbox).orderBy(desc(s.auditOutbox.id)).limit(1))[0]?.id ?? 0;
const eventsSince = async (m: number) =>
  (await app.db.select().from(s.auditOutbox).where(gt(s.auditOutbox.id, m)).orderBy(asc(s.auditOutbox.id))).map((r) => AuditEventSchema.parse(r.event));

describe("GET /qr-orders - the counter's queue", () => {
  it("shows a counter its own outlet's paid orders, a role for every outlet all of them, and never an unpaid one", async () => {
    const mine = await paidOrder();
    const theirs = await paidOrder(kioskCode.token, [{ it: "chips", qty: 1 }], "Bed 12");
    const unpaid = await app.inject({ method: "POST", url: `${API_PREFIX}/public/qr/${coffee.token}/orders`, remoteAddress: nextIp(), payload: { nonce: randomUUID(), name: "X", phone: nextPhone(), lines: [{ it: "capp", qty: 1 }] } });

    const u1 = await queue("u1");
    expect(u1.orders.every((o) => o.loc === "coffee")).toBe(true);
    expect(u1.orders.map((o) => o.id)).toContain(mine.id);
    expect(u1.orders.map((o) => o.id)).not.toContain(unpaid.json().result.order.id);
    expect(u1.paused).toEqual({ coffee: false });
    expect(u1.hours).toEqual([{ loc: "coffee", days: ALL_DAY }]);
    const o = u1.orders.find((x) => x.id === mine.id)!;
    expect(o).toMatchObject({ status: "Paid", name: "Ravi", billNo: mine.billNo, refund: null, label: "Table 4", mode: "pickup" });
    expect(o.hist!.map((h) => h.s)).toEqual(["Awaiting payment", "Paid"]);

    const u6 = await queue("u6");
    expect(u6.orders.map((x) => x.id)).toEqual([theirs.id]);
    expect(u6.orders[0]).toMatchObject({ mode: "deliver", spot: "Bed 12" });

    const u2 = await queue("u2");
    expect(u2.orders.map((x) => x.id)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect(Object.keys(u2.paused).sort()).toEqual(["coffee", "kiosk", "rest"]);
  });

  it("is not there for a desk without QR orders", async () => {
    expect((await as("u3", "GET", "/qr-orders")).statusCode).toBe(404);
  });
});

describe("POST /qr-orders/:id/status - the counter's next step", () => {
  it("walks a pickup to Collected and a delivery to Delivered, one step at a time", async () => {
    const p = await paidOrder();
    for (const to of ["Preparing", "Ready", "Collected"]) {
      const r = await as("u1", "POST", `/qr-orders/${p.id}/status`, { to });
      expect(r.statusCode, r.body).toBe(200);
      expect(QrOrderSchema.parse(r.json().result).status).toBe(to);
      expect(r.json().changed).toEqual(["qrOrders"]);
    }
    const d = await paidOrder(kioskCode.token, [{ it: "chips", qty: 1 }], "Bed 3");
    for (const to of ["Preparing", "Out for delivery", "Delivered"]) expect((await as("u6", "POST", `/qr-orders/${d.id}/status`, { to })).statusCode).toBe(200);
    const last = await as("u6", "POST", `/qr-orders/${d.id}/status`, { to: "Delivered" });
    expect(last.statusCode).toBe(422);
    expect(last.json().error.message).toBe(`${d.id} is delivered and has no next step.`);
  });

  it("refuses a step that is not the mode's next one, a void, another outlet's order and an unknown one", async () => {
    const p = await paidOrder();
    const skip = await as("u1", "POST", `/qr-orders/${p.id}/status`, { to: "Ready" });
    expect(skip.statusCode).toBe(422);
    expect(skip.json().error.message).toBe(`${p.id} is paid - its next step is preparing.`);
    await as("u1", "POST", `/qr-orders/${p.id}/status`, { to: "Preparing" });
    const wrongPath = await as("u1", "POST", `/qr-orders/${p.id}/status`, { to: "Out for delivery" });
    expect(wrongPath.statusCode).toBe(422);
    const voided = await as("u1", "POST", `/qr-orders/${p.id}/status`, { to: "Voided" });
    expect(voided.json().error.message).toBe(`A QR order is voided with its bill - void ${p.billNo} instead.`);
    expect((await as("u6", "POST", `/qr-orders/${p.id}/status`, { to: "Ready" })).statusCode).toBe(403);
    // The seeded manager holds QR orders at view: edit is missing, and could be granted - a 403.
    expect((await as("u2", "POST", `/qr-orders/${p.id}/status`, { to: "Ready" })).statusCode).toBe(403);
    expect((await as("u1", "POST", "/qr-orders/QO-2099-0001/status", { to: "Ready" })).statusCode).toBe(404);
  });
});

describe("PUT /outlets/:loc/qr-pause - the counter's switch", () => {
  it("pauses and resumes its own outlet, with the before on the audit event", async () => {
    const m = await mark();
    const r = await as("u1", "PUT", "/outlets/coffee/qr-pause", { paused: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ result: { loc: "coffee", paused: true }, changed: ["qrOrders"], message: "QR ordering at Coffee Shop is paused - new orders are refused until you resume it" });
    expect((await eventsSince(m)).find((e) => e.action === "setQrPause")).toMatchObject({ before: { paused: false } });
    const menu = await app.inject({ method: "GET", url: `${API_PREFIX}/public/qr/${coffee.token}` });
    expect(menu.json().paused).toBe(true);
    const again = await as("u1", "PUT", "/outlets/coffee/qr-pause", { paused: true });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe("QR ordering at Coffee Shop is already paused");
    expect((await as("u1", "PUT", "/outlets/coffee/qr-pause", { paused: false })).json().message).toBe("QR ordering at Coffee Shop is back on");
  });

  it("refuses a closed outlet's switch, with the before on the refusal's audit event", async () => {
    await app.db.update(s.locations).set({ active: false }).where(eq(s.locations.key, "coffee"));
    try {
      const m = await mark();
      const r = await as("u1", "PUT", "/outlets/coffee/qr-pause", { paused: true });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.message).toBe("Refused - Coffee Shop is closed");
      await app.auditSettled();
      expect((await eventsSince(m)).find((e) => e.action === "setQrPause")).toMatchObject({ outcome: "refused", before: { paused: false } });
    } finally {
      await app.db.update(s.locations).set({ active: true }).where(eq(s.locations.key, "coffee"));
    }
  });

  it("refuses another outlet's switch", async () => {
    expect((await as("u6", "PUT", "/outlets/coffee/qr-pause", { paused: true })).statusCode).toBe(403);
  });
});

describe("a void of a QR bill refunds it", () => {
  it("voids the order with its bill, queues the whole bill back to the customer, and says so", async () => {
    const p = await paidOrder(coffee.token, [{ it: "juice", qty: 2 }]);
    const r = await as("u2", "POST", `/bills/${encodeURIComponent(p.billNo)}/void`, { reason: "Customer changed their mind" });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.message).toBe(`${p.billNo} voided - ₹40.00 is being refunded to the customer's UPI/card`);
    expect(body.changed).toEqual(["stock", "bills", "qrOrders"]);
    const bill = BillSchema.parse(body.result);
    expect(bill).toMatchObject({ voided: true, src: "qr", qo: p.id, refund: { id: `${p.id}-R1`, status: "Pending", amount: 40 } });
    const [order] = await app.db.select().from(s.qrOrders).where(eq(s.qrOrders.id, p.id));
    expect(order.status).toBe("Voided");
    const [refund] = await app.db.select().from(s.paymentRefunds).where(eq(s.paymentRefunds.qrOrderId, p.id));
    expect(refund).toMatchObject({ reason: "void", billNo: p.billNo, amount: 40, status: "Pending" });

    const bills = await as("u2", "GET", "/bills");
    const listed = (bills.json() as { no: string; refund?: unknown }[]).find((b) => b.no === p.billNo)!;
    expect(listed.refund).toEqual({ id: `${p.id}-R1`, status: "Pending", amount: 40 });
    const till = (bills.json() as { src?: string; refund?: unknown }[]).find((b) => b.src === undefined)!;
    expect(till).not.toHaveProperty("refund");
  });
});

describe("POST /qr-refunds/:id/retry", () => {
  it("puts a failed refund back in the queue for whoever holds Void a bill", async () => {
    const p = await paidOrder();
    await as("u2", "POST", `/bills/${encodeURIComponent(p.billNo)}/void`, { reason: "Wrong order" });
    const id = `${p.id}-R1`;
    expect((await as("u2", "POST", `/qr-refunds/${id}/retry`)).json().error.message).toBe(`Refund ${id} is pending - only a failed refund can be retried`);
    await app.db.update(s.paymentRefunds).set({ status: "Failed", attempts: 6, lastError: "Insufficient balance" }).where(eq(s.paymentRefunds.id, id));
    // The refusal above is audited after its reply: let it land before the mark, or it lands after.
    await app.auditSettled();
    const m = await mark();
    const r = await as("u2", "POST", `/qr-refunds/${id}/retry`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result).toEqual({ id, status: "Pending", reason: "void", amount: 20, attempts: 0 });
    expect(r.json().message).toBe(`Refund ${id} of ₹20.00 is queued again - it goes to the payment gateway shortly`);
    expect((await eventsSince(m)).find((e) => e.action === "retryQrRefund" && e.outcome === "done")).toMatchObject({ before: { status: "Failed", attempts: 6, lastError: "Insufficient balance" } });
    // The seeded counter does not hold Void a bill (it could be granted it): a 403.
    expect((await as("u1", "POST", `/qr-refunds/${id}/retry`)).statusCode).toBe(403);
    expect((await as("u2", "POST", "/qr-refunds/QO-2099-0001-R1/retry")).statusCode).toBe(404);
  });
});

describe("the admin's codes and hours", () => {
  it("lists, creates, renames, switches off, regenerates - and a dead code dies like an unknown one", async () => {
    const list = await as("u7", "GET", "/admin/qr-codes");
    expect(list.statusCode).toBe(200);
    expect(AdminQrCodesResponseSchema.parse(list.json()).hours.map((h) => h.loc).sort()).toEqual(["coffee", "kiosk", "rest"]);

    const made = await as("u7", "POST", "/admin/qr-codes", { loc: "rest", label: "Table 9", mode: "deliver" });
    expect(made.statusCode, made.body).toBe(200);
    const code = made.json().result;
    expect(code).toMatchObject({ id: expect.stringMatching(/^QR-\d{3,}$/), loc: "rest", label: "Table 9", mode: "deliver", active: true });
    expect(code.token).toHaveLength(32);
    expect(made.json().changed).toEqual(["qrCodes"]);

    const nothing = await as("u7", "PATCH", `/admin/qr-codes/${code.id}`, { label: "Table 9" });
    expect(nothing.statusCode).toBe(422);
    expect(nothing.json().error.message).toBe(`Nothing to save - ${code.id} already reads that way`);
    const renamed = await as("u7", "PATCH", `/admin/qr-codes/${code.id}`, { label: "Table 10", mode: "pickup" });
    expect(renamed.json().result).toMatchObject({ label: "Table 10", mode: "pickup" });

    const menu = (t: string) => app.inject({ method: "GET", url: `${API_PREFIX}/public/qr/${t}` });
    const off = await as("u7", "PATCH", `/admin/qr-codes/${code.id}`, { active: false });
    expect(off.json().message).toBe(`${code.id} "Table 10" is switched off - its poster no longer opens the menu`);
    expect((await menu(code.token)).json().error.message).toBe(CODE_GONE);
    expect((await as("u7", "PATCH", `/admin/qr-codes/${code.id}`, { active: true })).json().message).toBe(`${code.id} "Table 10" is switched back on`);

    const m = await mark();
    const regen = await as("u7", "POST", `/admin/qr-codes/${code.id}/regenerate`);
    expect(regen.statusCode).toBe(200);
    expect(regen.json().result.token).not.toBe(code.token);
    expect(regen.json().result.rotatedAt).toBeTruthy();
    expect((await menu(code.token)).statusCode).toBe(404);
    expect((await menu(code.token)).json().error.message).toBe(CODE_GONE);
    expect((await menu(regen.json().result.token)).statusCode).toBe(200);
    const e = (await eventsSince(m)).find((x) => x.action === "regenerateQrCode")!;
    expect(e.before).toEqual({ token: "••••" });
    expect(JSON.stringify(e)).not.toContain(regen.json().result.token);
  });

  it("refuses a code at a closed outlet or at a location that is not an outlet, and is the super admin's alone", async () => {
    await app.db.insert(s.locations).values({ key: "shut", name: "Old Canteen", code: "OT-OC", type: "Outlet", floor: "B1", costCentre: "CC-OC", active: false });
    const shut = await as("u7", "POST", "/admin/qr-codes", { loc: "shut", label: "Door", mode: "pickup" });
    expect(shut.statusCode).toBe(422);
    expect(shut.json().error.message).toBe("Refused - Old Canteen is closed; reopen it before adding a QR code");
    expect((await as("u7", "POST", "/admin/qr-codes", { loc: "store", label: "Door", mode: "pickup" })).statusCode).toBe(404);
    expect((await as("u2", "GET", "/admin/qr-codes")).statusCode).toBe(404);
    expect((await as("u7", "PATCH", "/admin/qr-codes/QR-999", { active: false })).statusCode).toBe(404);
  });

  it("replaces an outlet's week of hours, and the menu follows", async () => {
    const r = await as("u7", "PUT", "/admin/outlets/rest/order-hours", { days: [{ dow: 3, opens: "09:00", closes: "17:00" }, { dow: 1, opens: "08:00", closes: "20:00" }] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result).toEqual({ loc: "rest", days: [{ dow: 1, opens: "08:00", closes: "20:00" }, { dow: 3, opens: "09:00", closes: "17:00" }] });
    expect(r.json().message).toBe("Ordering hours saved for Restaurant - QR orders 2 days a week");
    // The counter's queue shows each outlet's hours, so it refetches too.
    expect(r.json().changed).toEqual(["qrCodes", "qrOrders"]);
    const all = await as("u7", "PUT", "/admin/outlets/rest/order-hours", { days: ALL_DAY });
    expect(all.json().message).toBe("Ordering hours saved for Restaurant - QR orders every day");
    const none = await as("u7", "PUT", "/admin/outlets/rest/order-hours", { days: [] });
    expect(none.json().message).toBe("Ordering hours saved for Restaurant - it takes no QR orders on any day");
    const bad = await as("u7", "PUT", "/admin/outlets/rest/order-hours", { days: [{ dow: 1, opens: "20:00", closes: "08:00" }] });
    expect(bad.statusCode).toBe(400);
    expect((await as("u7", "PUT", "/admin/outlets/kitchen/order-hours", { days: [] })).statusCode).toBe(404);
    // A closed outlet's hours are refused like a new code there.
    await app.db.insert(s.locations).values({ key: "shut2", name: "Night Canteen", code: "OT-NC", type: "Outlet", floor: "B2", costCentre: "CC-NC", active: false });
    const shut = await as("u7", "PUT", "/admin/outlets/shut2/order-hours", { days: ALL_DAY });
    expect(shut.statusCode).toBe(422);
    expect(shut.json().error.message).toBe("Refused - Night Canteen is closed; reopen it before setting its QR ordering hours");
  });
});

describe("the rest of the server", () => {
  it("counts a paid order not yet handed over among an outlet's close blockers", async () => {
    await app.db.insert(s.locations).values({ key: "popup", name: "Pop-up Stall", code: "OT-PU", type: "Outlet", floor: "G", costCentre: "CC-PU", active: true });
    await given.qrOrder(app.db, { loc: "popup", st: "Paid", lines: [{ it: "capp", qty: 1, rate: 75 }] });
    const r = await as("u7", "POST", "/admin/outlets/popup/close");
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Refused - Pop-up Stall still has 1 open QR order");
  });

  it("puts a QR bill on the X report as Online - collected, but not cash in the drawer - and on nobody's shift", async () => {
    const login = await app.inject({ method: "POST", url: `${API_PREFIX}/auth/login`, payload: { emp: "RC-4471", password: "changeme" } });
    expect(login.statusCode, login.body).toBe(200);
    const shiftHeaders = { authorization: `Bearer ${login.json().accessToken}` };
    const shift = async () => (await app.inject({ method: "GET", url: `${API_PREFIX}/shifts/current`, headers: shiftHeaders })).json().shift;
    const x = async () => RegisterReportSchema.parse((await as("u2", "GET", "/register/x?loc=coffee")).json()).totals;
    const tender = (t: Awaited<ReturnType<typeof x>>, name: string) => t.tenders.find((l) => l.tender === name)?.amount ?? 0;

    const before = await x();
    const shiftBefore = await shift();
    await paidOrder(coffee.token, [{ it: "water", qty: 3 }]);
    const after = await x();
    expect(tender(after, "Online") - tender(before, "Online")).toBe(60);
    expect(after.collected - before.collected).toBe(60);
    expect(tender(after, "Cash")).toBe(tender(before, "Cash"));
    const shiftAfter = await shift();
    expect(shiftAfter.totals.billCount).toBe(shiftBefore.totals.billCount);
    expect(shiftAfter.totals.collected).toBe(shiftBefore.totals.collected);
  });

  it("keeps a QR order's secret out of the request log", async () => {
    const lines: string[] = [];
    const logged = await buildApp(testConfig({ LOG_LEVEL: "info" }), {
      db: app.db, migrationsSchema: app.testDb!.schemaName, payments: fake, logStream: { write: (l: string) => { lines.push(l); } },
    });
    try {
      const secret = "SuperSecretOrderKey_0123456789abcdefghijklm";
      await logged.inject({ method: "GET", url: `${API_PREFIX}/public/orders/QO-2099-0001?k=${secret}` });
      await logged.inject({ method: "GET", url: `${API_PREFIX}/public/orders?k=${secret}` });
      const text = lines.join("\n");
      expect(text).toContain("/public/orders");
      expect(text).not.toContain(secret);
      expect(text).toContain("k=[redacted]");
    } finally { await logged.close(); }
  });
});
