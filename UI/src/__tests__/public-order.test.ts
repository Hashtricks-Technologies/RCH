import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicQrOrder } from "@rch/contract";
import { customerPhoneRefusal, QR_MAX_LINES, QR_MAX_QTY } from "@rch/domain";
import { setAccessToken } from "../api/session";
import { isOrderPath, menuPath, parseOrderPath, secretFromHash, statusUrl } from "../lib/orderPath";
import {
  CHECKOUT_FAILED, CHECKOUT_JS, NETWORK_MENU, NETWORK_PLACE, PAYMENT_DISMISSED, POLL_FAST_MS, POLL_SLOW_MS, VERIFY_PENDING,
  CHECKOUT_BACKSTOP_MS, cartCount, cartTotal, checkCustomer, loadRazorpay, paymentFailedNote, recall, remember, resetPublicOrder, usePublicOrder,
  type RazorpayFailure, type RazorpaySuccess,
} from "../store/publicOrder";
import { SECRET, TOKEN, created, json, menuOf, orderOf, refusal } from "./publicFixture";

/**
 * The public QR ordering page's store, against a stubbed `fetch` and a stubbed Razorpay: the menu
 * read, the cart's caps, placing an order (one nonce per attempt, however many retries), the
 * checkout, the verify, and the status poll. The rules behind each refusal belong to the API.
 */

const fetchMock = vi.fn();
type Stubs = Record<string, () => Response | Promise<Response>>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return make ? Promise.resolve(make()) : Promise.resolve(json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const calls = () => fetchMock.mock.calls.map((c) => {
  const [u, init] = c as [string, RequestInit];
  return { url: String(u), at: `${init.method} ${String(u).split("?")[0]}`, headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, unknown>) };
});
const hit = (at: string) => calls().filter((c) => c.at === at);

const MENU = `GET /api/v1/public/qr/${TOKEN}`;
const PLACE = `POST /api/v1/public/qr/${TOKEN}/orders`;
const VERIFY = "POST /api/v1/public/orders/QO-2026-0042/verify";
const STATUS = "GET /api/v1/public/orders/QO-2026-0042";

/** A stand-in for Razorpay's checkout: records what it was opened with. */
type Opened = { options: Record<string, unknown> & { handler: (r: RazorpaySuccess) => void; modal: { ondismiss: () => void } }; opened: boolean; failed?: (r: RazorpayFailure) => void };
let rzp: Opened[] = [];
function stubRazorpay(): void {
  window.Razorpay = class {
    rec: Opened;
    constructor(options: Opened["options"]) { this.rec = { options, opened: false }; rzp.push(this.rec); }
    open() { this.rec.opened = true; }
    on(event: string, cb: (r: RazorpayFailure) => void) { if (event === "payment.failed") this.rec.failed = cb; }
  } as unknown as typeof window.Razorpay;
}
const SUCCESS: RazorpaySuccess = { razorpay_order_id: "order_RZP1", razorpay_payment_id: "pay_1", razorpay_signature: "f".repeat(64) };

const st = () => usePublicOrder.getState();
async function withMenu(menu = menuOf()) {
  serve({ [MENU]: () => json(menu) });
  await st().loadMenu(TOKEN);
  fetchMock.mockClear();
}
const fillCustomer = () => { st().setCustomer({ name: "Asha", phone: "+91 98430 22118" }); };

beforeEach(() => {
  resetPublicOrder();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  rzp = [];
  stubRazorpay();
  localStorage.clear();
  window.history.replaceState(null, "", `/order/${TOKEN}`);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.Razorpay;
  document.querySelectorAll(`script[src="${CHECKOUT_JS}"]`).forEach((s) => { s.remove(); });
  setAccessToken(null);
});

describe("addresses", () => {
  it("reads the menu and status paths, and nothing else", () => {
    expect(isOrderPath("/order/x")).toBe(true);
    expect(isOrderPath("/pos")).toBe(false);
    expect(parseOrderPath(`/order/${TOKEN}`)).toEqual({ view: "menu", token: TOKEN });
    expect(parseOrderPath(`/order/${TOKEN}/`)).toEqual({ view: "menu", token: TOKEN });
    expect(parseOrderPath(`/order/${TOKEN}/o/QO-2026-0042`)).toEqual({ view: "status", token: TOKEN, id: "QO-2026-0042" });
    expect(parseOrderPath("/order/")).toEqual({ view: "none" });
    expect(parseOrderPath(`/order/${TOKEN}/x/QO-1`)).toEqual({ view: "none" });
    expect(parseOrderPath("/order/%E0%A4%A")).toEqual({ view: "none" });
    expect(parseOrderPath("/pos")).toEqual({ view: "none" });
  });
  it("keeps the secret in the fragment, never the path or query", () => {
    const u = statusUrl(TOKEN, "QO-2026-0042", SECRET);
    expect(u).toBe(`/order/${TOKEN}/o/QO-2026-0042#k=${SECRET}`);
    expect(u.split("#")[0]).not.toContain(SECRET);
    expect(menuPath(TOKEN)).toBe(`/order/${TOKEN}`);
    expect(secretFromHash(`#k=${SECRET}`)).toBe(SECRET);
    expect(secretFromHash(`k=${SECRET}&x=1`)).toBe(SECRET);
    expect(secretFromHash("")).toBeNull();
    expect(secretFromHash("#k=")).toBeNull();
  });
});

describe("the menu", () => {
  it("loads through the manifest route with no token and no idempotency key", async () => {
    setAccessToken("staff-token-on-this-device");
    serve({ [MENU]: () => json(menuOf()) });
    await st().loadMenu(TOKEN);
    expect(st().menuState).toBe("ready");
    expect(st().menu?.outlet.name).toBe("Coffee Shop");
    const [c] = calls();
    expect(c.headers.authorization).toBeUndefined();
    expect(c.headers["idempotency-key"]).toBeUndefined();
  });
  it("reads an unknown code as missing, and an outage as an outage", async () => {
    serve({ [MENU]: () => json({ error: { code: "not_found", message: "Not found." } }, 404) });
    await st().loadMenu(TOKEN);
    expect(st().menuState).toBe("missing");
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await st().loadMenu(TOKEN);
    expect(st().menuState).toBe("error");
    expect(st().menuError).toBe(NETWORK_MENU);
  });
  it("keeps the menu on screen when a reload fails, and drops cart lines no longer sold", async () => {
    await withMenu();
    st().add("tea"); st().add("cake");
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await st().loadMenu(TOKEN);
    expect(st().menuState).toBe("ready");
    const m = menuOf();
    m.items[1] = { ...m.items[1], available: false };
    serve({ [MENU]: () => json(m) });
    await st().loadMenu(TOKEN);
    expect(st().cart).toEqual({ tea: 1 });
  });
  it("a 401 on a public route signs nobody out and refreshes nothing", async () => {
    serve({ [MENU]: () => json({ error: { code: "unauthenticated", message: "No." } }, 401) });
    await st().loadMenu(TOKEN);
    expect(hit("POST /api/v1/auth/refresh")).toHaveLength(0);
    expect(st().menuError).toBe("No.");
  });
});

describe("the cart", () => {
  it("adds, removes and totals", async () => {
    await withMenu();
    st().add("tea"); st().add("tea"); st().add("cake");
    expect(st().cart).toEqual({ tea: 2, cake: 1 });
    expect(cartCount(st().cart)).toBe(3);
    expect(cartTotal(st().menu, st().cart)).toBe(85);
    st().remove("tea"); st().remove("cake");
    expect(st().cart).toEqual({ tea: 1 });
    st().setQty("tea", 0);
    expect(st().cart).toEqual({});
  });
  it("clamps to the item's own figure and says so", async () => {
    await withMenu();
    st().setQty("cake", 9);
    expect(st().cart.cake).toBe(3);
    expect(st().notice).toBe("Only 3 of Plum Cake can be ordered right now.");
    st().clearNotice();
    st().add("cake");
    expect(st().cart.cake).toBe(3);
    expect(st().notice).toContain("Only 3");
  });
  it("clamps to the per-item cap", async () => {
    await withMenu(menuOf({ items: [{ it: "tea", name: "Masala Tea", price: 20, available: true, max: 99, type: "MTO" }] }));
    st().setQty("tea", 50);
    expect(st().cart.tea).toBe(QR_MAX_QTY);
    expect(st().notice).toBe(`One order can carry at most ${QR_MAX_QTY} of one item.`);
  });
  it("stops at the line cap", async () => {
    const items = Array.from({ length: QR_MAX_LINES + 1 }, (_, i) => ({ it: `i${i}`, name: `Item ${i}`, price: 1, available: true, max: 5, type: "FG" as const }));
    await withMenu(menuOf({ items }));
    for (const i of items) st().add(i.it);
    expect(Object.keys(st().cart)).toHaveLength(QR_MAX_LINES);
    expect(st().notice).toBe(`One order can carry at most ${QR_MAX_LINES} different items.`);
  });
  it("takes nothing sold out, unknown, or while the outlet is closed or paused", async () => {
    await withMenu();
    st().add("juice"); st().add("nope");
    expect(st().cart).toEqual({});
    await withMenu(menuOf({ paused: true }));
    st().add("tea");
    expect(st().cart).toEqual({});
    await withMenu(menuOf({ open: { open: false, why: "QR ordering opens at 08:00 today.", today: { opens: "08:00", closes: "20:00" } } }));
    st().add("tea");
    expect(st().cart).toEqual({});
  });
});

describe("the customer's details", () => {
  it("wants a name and a phone, refused in the till's own words", () => {
    expect(checkCustomer({ name: " ", phone: "", detail: "" })).toEqual({ name: expect.any(String), phone: "Enter your phone number." });
    expect(checkCustomer({ name: "Asha", phone: "12345", detail: "" })).toEqual({ phone: customerPhoneRefusal("12345") });
    expect(checkCustomer({ name: "Asha", phone: "098430 22118", detail: "" })).toEqual({});
  });
});

describe("placing an order", () => {
  it("sends the cart, the details and a nonce, then opens the checkout", async () => {
    await withMenu(menuOf({ qr: { label: "Ward 3B", mode: "deliver" } }));
    st().add("tea"); st().add("tea");
    fillCustomer();
    st().setCustomer({ detail: "  Bed 12 " });
    serve({ [PLACE]: () => json({ result: created(), changed: [], message: "Order placed." }) });
    expect(await st().placeOrder()).toBe(true);
    const [c] = hit(PLACE);
    expect(c.body).toEqual({ nonce: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "Asha", phone: "9843022118", detail: "Bed 12", lines: [{ it: "tea", qty: 2 }] });
    expect(c.headers["idempotency-key"]).toBeUndefined();
    expect(rzp).toHaveLength(1);
    expect(rzp[0].opened).toBe(true);
    expect(rzp[0].options).toMatchObject({
      key: "rzp_test_key", order_id: "order_RZP1", amount: 4000, currency: "INR", name: "Coffee Shop",
      description: "Order QO-2026-0042", prefill: { name: "Asha", contact: "9843022118" }, theme: { color: "#E07B00" }, timeout: 900,
    });
    expect(recall("QO-2026-0042")).toBe(SECRET);
  });
  it("sends no detail on a pickup code", async () => {
    await withMenu();
    st().add("tea"); fillCustomer(); st().setCustomer({ detail: "Bed 12" });
    serve({ [PLACE]: () => json({ result: created(), changed: [], message: "Order placed." }) });
    await st().placeOrder();
    expect(hit(PLACE)[0].body).not.toHaveProperty("detail");
  });
  it("sends nothing with a detail missing or an empty cart", async () => {
    await withMenu();
    fillCustomer();
    expect(await st().placeOrder()).toBe(false);
    st().add("tea"); st().setCustomer({ phone: "123" });
    expect(await st().placeOrder()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("keeps the nonce for a retry of the same order, and mints a new one when the order changes", async () => {
    await withMenu();
    st().add("tea"); fillCustomer();
    serve({ [PLACE]: () => refusal("Coffee Shop has paused QR orders for now - please order at the counter.") });
    expect(await st().placeOrder()).toBe(false);
    expect(st().error).toBe("Coffee Shop has paused QR orders for now - please order at the counter.");
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await st().placeOrder()).toBe(false);
    expect(st().error).toBe(NETWORK_PLACE);
    serve({ [PLACE]: () => json({ result: created(), changed: [], message: "Order placed." }) });
    expect(await st().placeOrder()).toBe(true);
    const nonces = calls().map((c) => c.body?.nonce);
    expect(nonces).toHaveLength(3);
    expect(new Set(nonces).size).toBe(1);
    // A different cart is a different order.
    resetPublicOrder();
    await withMenu();
    st().add("tea"); fillCustomer();
    serve({ [PLACE]: () => refusal("No.") });
    await st().placeOrder();
    st().add("tea");
    await st().placeOrder();
    const [a, b] = hit(PLACE).map((c) => c.body?.nonce);
    expect(a).not.toBe(b);
  });
  it("mints a new nonce after a 409, since that attempt's order is settled or lapsed", async () => {
    await withMenu();
    st().add("tea"); fillCustomer();
    serve({ [PLACE]: () => refusal("That order has already been paid - scan the code again for a new one.", 409) });
    expect(await st().placeOrder()).toBe(false);
    expect(st().attempt).toBeNull();
    await st().placeOrder();
    const [a, b] = hit(PLACE).map((c) => c.body?.nonce);
    expect(a).not.toBe(b);
  });
  it("reopens the same order's checkout rather than placing a second", async () => {
    await withMenu();
    st().add("tea"); fillCustomer();
    serve({ [PLACE]: () => json({ result: created(), changed: [], message: "Order placed." }) });
    await st().placeOrder();
    rzp[0].options.modal.ondismiss();
    expect(st().paying).toBe(false);
    expect(st().note).toBe(PAYMENT_DISMISSED);
    expect(await st().placeOrder()).toBe(true);
    expect(hit(PLACE)).toHaveLength(1);
    expect(rzp).toHaveLength(2);
  });
  it("tolerates storage that throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    remember({ orderId: "QO-1", secret: SECRET, token: TOKEN });
    expect(recall("QO-1")).toBeNull();
    await withMenu();
    st().add("tea"); fillCustomer();
    serve({ [PLACE]: () => json({ result: created(), changed: [], message: "Order placed." }) });
    expect(await st().placeOrder()).toBe(true);
    expect(rzp[0].opened).toBe(true);
  });
  it("recalls only the order it remembered", () => {
    remember({ orderId: "QO-1", secret: SECRET, token: TOKEN });
    expect(recall("QO-1")).toBe(SECRET);
    expect(recall("QO-2")).toBeNull();
    localStorage.setItem("rch-qr-order", "{not json");
    expect(recall("QO-1")).toBeNull();
  });
});

describe("the checkout script", () => {
  it("is injected once, on demand", async () => {
    delete window.Razorpay;
    const p1 = loadRazorpay();
    const p2 = loadRazorpay();
    const tags = document.querySelectorAll<HTMLScriptElement>(`script[src="${CHECKOUT_JS}"]`);
    expect(tags).toHaveLength(1);
    stubRazorpay();
    tags[0].onload?.(new Event("load"));
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
    await expect(loadRazorpay()).resolves.toBeUndefined();
  });
  it("says so when it cannot load, and tries again next time", async () => {
    delete window.Razorpay;
    await withMenu();
    st().add("tea"); fillCustomer();
    serve({ [PLACE]: () => json({ result: created(), changed: [], message: "Order placed." }) });
    const placing = st().placeOrder();
    await vi.waitFor(() => { expect(document.querySelector(`script[src="${CHECKOUT_JS}"]`)).not.toBeNull(); });
    const tag = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_JS}"]`)!;
    tag.onerror?.(new Event("error"));
    await placing;
    expect(st().error).toBe(CHECKOUT_FAILED);
    expect(st().paying).toBe(false);
    expect(document.querySelector(`script[src="${CHECKOUT_JS}"]`)).toBeNull();
    // A script that loads but defines nothing is a failure too.
    const again = loadRazorpay();
    document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_JS}"]`)!.onload?.(new Event("load"));
    await expect(again).rejects.toThrow();
  });
});

describe("a checkout that goes wrong", () => {
  async function place() {
    await withMenu();
    st().add("tea"); fillCustomer();
    serve({ [PLACE]: () => json({ result: created(), changed: [], message: "Order placed." }) });
    return st().placeOrder();
  }
  it("unlocks Pay when the gateway's constructor throws", async () => {
    window.Razorpay = class { constructor() { throw new Error("blocked"); } } as unknown as typeof window.Razorpay;
    await place();
    expect(st().paying).toBe(false);
    expect(st().error).toBe(CHECKOUT_FAILED);
  });
  it("unlocks Pay when open() throws", async () => {
    window.Razorpay = class { on() { /* */ } open() { throw new Error("popup"); } } as unknown as typeof window.Razorpay;
    await place();
    expect(st().paying).toBe(false);
    expect(st().error).toBe(CHECKOUT_FAILED);
  });
  it("notes a declined payment but keeps waiting while the sheet offers a retry, then says it on dismiss", async () => {
    await place();
    rzp[0].failed!({ error: { description: "Your bank declined the payment" } });
    expect(st().paying).toBe(true);
    expect(st().note).toBe(paymentFailedNote("Your bank declined the payment"));
    expect(st().note).toBe("Your payment did not go through: Your bank declined the payment. Tap Pay to try again - you have not been charged.");
    rzp[0].options.modal.ondismiss();
    expect(st().paying).toBe(false);
    expect(st().note).toBe(paymentFailedNote("Your bank declined the payment"));
    expect(paymentFailedNote()).toBe("Your payment did not go through. Tap Pay to try again - you have not been charged.");
  });
  it("gives Pay back after the gateway's timeout and a margin, if nothing ever calls back", async () => {
    vi.useFakeTimers();
    await place();
    expect(st().paying).toBe(true);
    await vi.advanceTimersByTimeAsync(CHECKOUT_BACKSTOP_MS - 1);
    expect(st().paying).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(st().paying).toBe(false);
    expect(st().note).toBe(PAYMENT_DISMISSED);
  });
  it("cancels the backstop once the sheet is dismissed", async () => {
    vi.useFakeTimers();
    await place();
    rzp[0].options.modal.ondismiss();
    usePublicOrder.setState({ paying: true, note: "still here" });
    await vi.advanceTimersByTimeAsync(CHECKOUT_BACKSTOP_MS);
    expect(st().note).toBe("still here");
  });
});

describe("verifying the payment", () => {
  async function placed() {
    await withMenu();
    st().add("tea"); st().add("tea"); fillCustomer();
    serve({ [PLACE]: () => json({ result: created(), changed: [], message: "Order placed." }) });
    await st().placeOrder();
  }
  it("forwards the checkout's answer with the secret, then shows the status page", async () => {
    await placed();
    serve({ [VERIFY]: () => json({ result: orderOf(), changed: [], message: "Payment received." }) });
    const moved = vi.fn();
    window.addEventListener("popstate", moved);
    rzp[0].options.handler(SUCCESS);
    await vi.waitFor(() => { expect(st().order?.status).toBe("Paid"); });
    window.removeEventListener("popstate", moved);
    expect(hit(VERIFY)[0].body).toEqual({ secret: SECRET, ...SUCCESS });
    expect(window.location.pathname).toBe(`/order/${TOKEN}/o/QO-2026-0042`);
    expect(window.location.hash).toBe(`#k=${SECRET}`);
    expect(window.location.search).toBe("");
    expect(moved).toHaveBeenCalled();
    expect(st().cart).toEqual({});
    expect(st().placed).toBeNull();
  });
  it("still goes to the status page when the verify fails, saying why", async () => {
    await placed();
    serve({ [VERIFY]: () => refusal("That payment could not be matched to this order.") });
    await st().verify(SUCCESS);
    expect(st().statusNote).toBe("That payment could not be matched to this order.");
    expect(window.location.pathname).toBe(`/order/${TOKEN}/o/QO-2026-0042`);
    await placed();
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await st().verify(SUCCESS);
    expect(st().statusNote).toBe(VERIFY_PENDING);
  });
  it("does nothing with no order placed", async () => {
    await st().verify(SUCCESS);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the status poll", () => {
  const visibility = (v: DocumentVisibilityState) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  afterEach(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); });

  it("reads with ?k=, every 5 s, and stops at a terminal status", async () => {
    vi.useFakeTimers();
    let status: PublicQrOrder["status"] = "Paid";
    serve({ [STATUS]: () => json(orderOf({ status })) });
    const stop = st().poll("QO-2026-0042", SECRET);
    await vi.advanceTimersByTimeAsync(0);
    expect(hit(STATUS)).toHaveLength(1);
    expect(calls()[0].url).toContain(`?k=${SECRET}`);
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(hit(STATUS)).toHaveLength(2);
    status = "Collected";
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(hit(STATUS)).toHaveLength(3);
    expect(st().order?.status).toBe("Collected");
    await vi.advanceTimersByTimeAsync(POLL_SLOW_MS * 4);
    expect(hit(STATUS)).toHaveLength(3);
    stop();
  });
  it("slows to 15 s after ten minutes", async () => {
    vi.useFakeTimers();
    serve({ [STATUS]: () => json(orderOf({ status: "Preparing" })) });
    const stop = st().poll("QO-2026-0042", SECRET);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const n = hit(STATUS).length;
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(hit(STATUS).length).toBe(n);
    await vi.advanceTimersByTimeAsync(POLL_SLOW_MS - POLL_FAST_MS);
    expect(hit(STATUS).length).toBe(n + 1);
    stop();
  });
  it("asks nothing while hidden and asks at once on coming back", async () => {
    vi.useFakeTimers();
    serve({ [STATUS]: () => json(orderOf({ status: "Preparing" })) });
    const stop = st().poll("QO-2026-0042", SECRET);
    await vi.advanceTimersByTimeAsync(0);
    visibility("hidden");
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 5);
    // The read already scheduled finds the tab hidden, asks nothing, and schedules nothing.
    expect(hit(STATUS)).toHaveLength(1);
    visibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(hit(STATUS)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS);
    expect(hit(STATUS)).toHaveLength(3);
    stop();
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 3);
    expect(hit(STATUS)).toHaveLength(3);
  });
  it("stops on an unknown order, and keeps the last status through an outage", async () => {
    vi.useFakeTimers();
    serve({ [STATUS]: () => json({ error: { code: "not_found", message: "Not found." } }, 404) });
    const stop = st().poll("QO-2026-0042", SECRET);
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS * 3);
    expect(st().orderState).toBe("missing");
    expect(hit(STATUS)).toHaveLength(1);
    stop();
    fetchMock.mockReset();
    await st().loadOrder("QO-2026-0042", SECRET).catch(() => undefined);
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await st().loadOrder("QO-2026-0042", SECRET);
    expect(st().orderState).toBe("error");
    serve({ [STATUS]: () => json(orderOf()) });
    await st().loadOrder("QO-2026-0042", SECRET);
    fetchMock.mockRejectedValue(new TypeError("offline"));
    await st().loadOrder("QO-2026-0042", SECRET);
    expect(st().stale).toBe(true);
    expect(st().order?.status).toBe("Paid");
  });
});
