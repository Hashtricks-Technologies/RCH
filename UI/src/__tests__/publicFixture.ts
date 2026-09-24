import type { PublicMenu, PublicQrOrder, QrOrderCreated } from "@rch/contract";

/** The public QR ordering page's fixtures, shared by its store and screen suites. */

export const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUV";
export const SECRET = "sec_0123456789abcdefghijklmnopqrstuvwxyzABCD";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const refusal = (message: string, status = 422) => json({ error: { code: "rule", message } }, status);

export const menuOf = (over: Partial<PublicMenu> = {}): PublicMenu => ({
  outlet: { loc: "coffee", name: "Coffee Shop" },
  qr: { label: "Table 4", mode: "pickup" },
  open: { open: true, today: { opens: "08:00", closes: "20:00" } },
  paused: false,
  items: [
    { it: "tea", name: "Masala Tea", price: 20, available: true, max: 20, type: "MTO", image: null },
    { it: "cake", name: "Plum Cake", price: 45, mrp: 50, available: true, max: 3, type: "MRP", image: "a".repeat(64) },
    { it: "juice", name: "Orange Juice", price: 60, available: false, why: "Sold out for today", max: 0, type: "FG" },
  ],
  ...over,
});

export const orderOf = (over: Partial<PublicQrOrder> = {}): PublicQrOrder => ({
  id: "QO-2026-0042", loc: "coffee", outletName: "Coffee Shop", label: "Table 4", mode: "pickup", spot: "",
  status: "Paid",
  lines: [{ it: "tea", name: "Masala Tea", qty: 2, rate: 20, amount: 40 }],
  total: 40, tax: 1.9, discount: 0, at: "2026-09-24T08:30:00.000Z", paidAt: "2026-09-24T08:31:00.000Z", billNo: "CF/1200",
  refund: null, steps: ["Paid", "Preparing", "Ready", "Collected"],
  ...over,
});

export const created = (over: Partial<PublicQrOrder> = {}): QrOrderCreated => ({
  order: orderOf({ status: "Awaiting payment", paidAt: undefined, billNo: undefined, ...over }),
  secret: SECRET,
  checkout: { keyId: "rzp_test_key", orderId: "order_RZP1", amount: 4000, currency: "INR", prefill: { name: "Asha", contact: "9843022118" } },
});

