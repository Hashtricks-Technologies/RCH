import { describe, expect, it } from "vitest";
import { API_PREFIX, isWriteRoute, need, act, routes } from "../routes";
import { BillSchema } from "./documents";
import {
  AdminQrCodeSchema, CreateQrOrderBodySchema, OrderHoursSchema, PublicMenuSchema, PublicQrOrderQuerySchema, PublicQrOrderSchema,
  QrOrderCreatedSchema, QrOrderSchema, QrOrdersResponseSchema, QrTokenParamsSchema, RAZORPAY_WEBHOOK_PATH, SetOrderHoursBodySchema,
  VerifyQrPaymentBodySchema,
} from "./qr";

const order = {
  nonce: "0b6f2c1e-8d4a-4f3b-9c2d-5e7a1b3c9d10", name: "  Anitha  ", phone: "98430 22118",
  lines: [{ it: "juice", qty: 2 }],
};
const line = (qty: number) => ({ it: "juice", qty });
const publicOrder = {
  id: "QO-2026-0001", loc: "coffee", outletName: "Coffee Shop", label: "Table 4", mode: "pickup", spot: "",
  status: "Paid", lines: [{ it: "juice", name: "Real Juice 200ml", qty: 2, rate: 20, amount: 40 }],
  total: 40, tax: 4.29, discount: 0, at: "2026-09-24T04:30:00.000Z", paidAt: "2026-09-24T04:31:00.000Z", billNo: "CF/1204",
  refund: null, steps: ["Paid", "Preparing", "Ready", "Collected"],
};

describe("placing a QR order", () => {
  it("takes a name, a phone and up to thirty lines of up to twenty each, and trims the name", () => {
    expect(CreateQrOrderBodySchema.parse(order).name).toBe("Anitha");
    expect(CreateQrOrderBodySchema.safeParse({ ...order, lines: Array.from({ length: 30 }, () => line(20)) }).success).toBe(true);
    expect(CreateQrOrderBodySchema.safeParse({ ...order, lines: Array.from({ length: 31 }, () => line(1)) }).success).toBe(false);
    for (const qty of [0, 21, 1.5, -1]) expect(CreateQrOrderBodySchema.safeParse({ ...order, lines: [line(qty)] }).success, String(qty)).toBe(false);
    expect(CreateQrOrderBodySchema.safeParse({ ...order, lines: [] }).success).toBe(false);
  });
  it("refuses a blank name, a missing nonce and a price the phone tried to set", () => {
    expect(CreateQrOrderBodySchema.safeParse({ ...order, name: "   " }).success).toBe(false);
    expect(CreateQrOrderBodySchema.safeParse({ ...order, nonce: "not-a-uuid" }).success).toBe(false);
    expect(CreateQrOrderBodySchema.safeParse({ ...order, lines: [{ it: "juice", qty: 1, rate: 1 }] }).success).toBe(false);
  });
  it("answers with the order, its secret once, and a checkout counted in paise", () => {
    const created = {
      order: publicOrder, secret: "s".repeat(43),
      checkout: { keyId: "rzp_test_x", orderId: "order_Pq7x2", amount: 4000, currency: "INR", prefill: { name: "Anitha", contact: "9843022118" } },
    };
    expect(QrOrderCreatedSchema.safeParse(created).success).toBe(true);
    expect(QrOrderCreatedSchema.safeParse({ ...created, checkout: { ...created.checkout, amount: 40.5 } }).success).toBe(false);
    expect(QrOrderCreatedSchema.safeParse({ ...created, checkout: { ...created.checkout, currency: "USD" } }).success).toBe(false);
  });
  it("verifies with the secret and the gateway's hex signature", () => {
    const v = { secret: "s".repeat(43), razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "f".repeat(64) };
    expect(VerifyQrPaymentBodySchema.safeParse(v).success).toBe(true);
    expect(VerifyQrPaymentBodySchema.safeParse({ ...v, razorpay_signature: "zz" }).success).toBe(false);
    expect(VerifyQrPaymentBodySchema.safeParse({ ...v, secret: "short" }).success).toBe(false);
  });
});

describe("what a phone reads", () => {
  it("reads a menu with the window, the pause switch and one line per item", () => {
    const menu = {
      outlet: { loc: "coffee", name: "Coffee Shop" }, qr: { label: "Table 4", mode: "deliver" },
      open: { open: false, why: "QR ordering opens at 08:00", today: { opens: "08:00", closes: "20:00" } }, paused: false,
      items: [{ it: "juice", name: "Real Juice 200ml", price: 20, mrp: 20, available: true, max: 20, image: null, type: "MRP" }],
    };
    expect(PublicMenuSchema.safeParse(menu).success).toBe(true);
    expect(PublicMenuSchema.safeParse({ ...menu, open: { open: false, today: null } }).success).toBe(true);
    expect(PublicMenuSchema.safeParse({ ...menu, qr: { label: "x", mode: "table" } }).success).toBe(false);
  });
  it("reads an order's status with its steps, and never its customer's phone", () => {
    expect(PublicQrOrderSchema.safeParse(publicOrder).success).toBe(true);
    expect(PublicQrOrderSchema.safeParse({ ...publicOrder, phone: "9843022118" }).success).toBe(false);
    expect(PublicQrOrderSchema.safeParse({ ...publicOrder, refund: { status: "Pending", amount: 40 } }).success).toBe(true);
  });
  it("shapes a token and a secret as base64url, and nothing else", () => {
    expect(QrTokenParamsSchema.safeParse({ token: "Abc-_123".repeat(4) }).success).toBe(true);
    expect(QrTokenParamsSchema.safeParse({ token: "../../etc/passwd" }).success).toBe(false);
    expect(PublicQrOrderQuerySchema.safeParse({ k: "k".repeat(43) }).success).toBe(true);
    expect(PublicQrOrderQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe("ordering hours", () => {
  const day = (dow: number, opens: string, closes: string) => ({ dow, opens, closes });
  it("takes one window per weekday, each closing after it opens", () => {
    expect(SetOrderHoursBodySchema.safeParse({ days: [day(0, "09:00", "13:00"), day(1, "07:30", "22:00")] }).success).toBe(true);
    expect(SetOrderHoursBodySchema.safeParse({ days: [] }).success).toBe(true);
    expect(OrderHoursSchema.safeParse({ loc: "coffee", days: [day(6, "00:00", "23:59")] }).success).toBe(true);
  });
  it("refuses a weekday twice, a window that closes before it opens, and a time that is not HH:MM", () => {
    expect(SetOrderHoursBodySchema.safeParse({ days: [day(1, "08:00", "12:00"), day(1, "14:00", "18:00")] }).success).toBe(false);
    expect(SetOrderHoursBodySchema.safeParse({ days: [day(2, "20:00", "08:00")] }).success).toBe(false);
    expect(SetOrderHoursBodySchema.safeParse({ days: [day(2, "08:00", "08:00")] }).success).toBe(false);
    expect(SetOrderHoursBodySchema.safeParse({ days: [day(3, "8:00", "12:00")] }).success).toBe(false);
    expect(SetOrderHoursBodySchema.safeParse({ days: [day(3, "08:00", "24:00")] }).success).toBe(false);
    expect(SetOrderHoursBodySchema.safeParse({ days: [day(7, "08:00", "12:00")] }).success).toBe(false);
  });
});

describe("the counter's queue and the admin's codes", () => {
  it("carries the customer's name and phone, the refund, and each outlet's pause", () => {
    const o = {
      ...publicOrder, name: "Anitha", phone: "9843022118",
      refund: { id: "RF-1", status: "Failed", reason: "void", amount: 40, attempts: 6, lastError: "gateway timeout" },
      hist: [{ s: "Paid", who: "QR Orders", t: "2026-09-24T04:31:00.000Z" }],
    };
    const { outletName: _o, steps: _s, ...staff } = o;
    expect(QrOrderSchema.safeParse(staff).success).toBe(true);
    expect(QrOrdersResponseSchema.safeParse({ orders: [staff], paused: { coffee: true }, hours: [] }).success).toBe(true);
  });
  it("reads a code with its token and when it was last regenerated", () => {
    const code = { id: "QR-001", loc: "coffee", label: "Table 4", mode: "pickup", token: "t".repeat(32), active: true, createdAt: "2026-09-24T04:30:00.000Z" };
    expect(AdminQrCodeSchema.safeParse(code).success).toBe(true);
    expect(AdminQrCodeSchema.safeParse({ ...code, rotatedAt: "2026-09-25T04:30:00.000Z" }).success).toBe(true);
  });
  it("marks a bill a QR order raised, and leaves a till's bill as it was", () => {
    const bill = { no: "CF/1204", loc: "coffee", opr: "sys-qr", oprCol: "", tot: 40, tax: 4.29, t: "12:01", pay: "Online", lines: [{ it: "juice", qty: 2, rate: 20 }] };
    expect(BillSchema.safeParse({ ...bill, src: "qr", qo: "QO-2026-0001", refund: { id: "RF-1", status: "Sent" } }).success).toBe(true);
    expect(BillSchema.parse({ ...bill, pay: "Cash" })).not.toHaveProperty("src");
    expect(BillSchema.safeParse({ ...bill, src: "kiosk" }).success).toBe(false);
  });
});

describe("the QR routes", () => {
  it("opens the customer's four to a phone with no token, and never at the password-change wall", () => {
    for (const k of ["publicQrMenu", "createQrOrder", "verifyQrPayment", "publicQrOrder"] as const) {
      expect(routes[k].access, k).toBe("public");
      expect(routes[k].allowMcp, k).toBeUndefined();
    }
    expect(isWriteRoute(routes.createQrOrder)).toBe(true);
    expect(isWriteRoute(routes.publicQrOrder)).toBe(false);
  });
  it("gates the queue on QR orders, the refund retry on the void, and the codes on the admin flag", () => {
    expect(routes.qrOrders.access).toEqual(need("qr_orders", "view"));
    expect(routes.setQrOrderStatus.access).toEqual(need("qr_orders", "edit"));
    expect(routes.setQrPause.access).toEqual(need("qr_orders", "edit"));
    expect(routes.retryQrRefund.access).toEqual(act("void_bill"));
    for (const k of ["adminQrCodes", "createQrCode", "updateQrCode", "regenerateQrCode", "setOrderHours"] as const) expect(routes[k].access, k).toBe("admin");
  });
  it("keeps the gateway's webhook out of the manifest, under the public prefix", () => {
    expect(API_PREFIX + RAZORPAY_WEBHOOK_PATH).toBe("/api/v1/public/razorpay/webhook");
    expect(Object.values(routes).some((r) => r.path === RAZORPAY_WEBHOOK_PATH)).toBe(false);
  });
});
