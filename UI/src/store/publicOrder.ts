import { create } from "zustand";
import { routes, type PublicMenu, type PublicMenuItem, type PublicQrOrder, type QrOrderCreated, type QrOrderStatus } from "@rch/contract";
import { customerPhoneRefusal, normalizePhone, QR_MAX_LINES, QR_MAX_QTY } from "@rch/domain";
import { ApiError, call } from "../api/client";
import { statusUrl } from "../lib/orderPath";

/**
 * The public QR ordering page's store. It is its own `create()`, not a slice of `useApp`: a
 * customer's phone has no session, no snapshot and no event stream, and nothing here may ever
 * reach the staff store's state (or the other way round).
 *
 * Every price shown is a preview. The server quotes every line again when the order is placed
 * and again when payment is captured, and what it answers is what the receipt prints.
 */

/** Where a paid order ends up; nothing moves it on from here, so the page stops asking. */
const QR_TERMINAL: ReadonlySet<QrOrderStatus> = new Set<QrOrderStatus>(["Collected", "Delivered", "Refunded", "Expired", "Voided"]);

/** Poll the status every 5 s while the tab is visible; every 15 s once the order is 10 minutes old. */
export const POLL_FAST_MS = 5_000;
export const POLL_SLOW_MS = 15_000;
const POLL_SLOW_AFTER_MS = 10 * 60_000;

export const CHECKOUT_JS = "https://checkout.razorpay.com/v1/checkout.js";
const STORAGE_KEY = "rch-qr-order";

/** Sentences for the failures that have no server envelope to read. */
export const NETWORK_MENU = "Could not load the menu - check your connection and try again.";
export const NETWORK_PLACE = "Could not place your order - check your connection and try again.";
export const CHECKOUT_FAILED = "Could not open the payment page - check your connection and try again.";
export const PAYMENT_DISMISSED = "Payment was not completed. Tap Pay to try again - you have not been charged.";
/** A payment the gateway turned down. Its sheet stays open to try again, so this is a note, not an error. */
export const paymentFailedNote = (why?: string): string =>
  `${why ? `Your payment did not go through: ${why.replace(/\.?$/, ".")}` : "Your payment did not go through."} Tap Pay to try again - you have not been charged.`;
export const VERIFY_PENDING = "We could not confirm your payment yet. This page will update as soon as it goes through.";

type LoadState = "idle" | "loading" | "ready" | "missing" | "error";

export type Customer = { name: string; phone: string; detail: string };
export type CustomerErrors = { name?: string; phone?: string };
export type RazorpaySuccess = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };

type RazorpayOptions = {
  key: string; order_id: string; amount: number; currency: string; name: string; description: string;
  prefill: { name: string; contact: string }; theme: { color: string };
  /** Seconds before the gateway's sheet gives up - inside the server's unpaid-order window. */
  timeout: number;
  handler: (r: RazorpaySuccess) => void; modal: { ondismiss: () => void };
};
/** What checkout.js hands a `payment.failed` listener; only the sentence is read. */
export type RazorpayFailure = { error?: { description?: string; reason?: string } };
type RazorpayCtor = new (o: RazorpayOptions) => { open: () => void; on: (event: "payment.failed", cb: (r: RazorpayFailure) => void) => void };
declare global { interface Window { Razorpay?: RazorpayCtor } }

/** An order placed and waiting for the gateway, with the signature of what was sent - a Pay
 *  pressed again for exactly the same cart reopens its checkout instead of placing another. */
type Placed = QrOrderCreated & { sig: string };

export type PublicOrderState = {
  token: string | null;
  menu: PublicMenu | null;
  menuState: LoadState;
  /** Why the menu could not be read, when it could not. */
  menuError: string | null;
  cart: Record<string, number>;
  /** A cap the last tap ran into, said once. */
  notice: string | null;
  customer: Customer;
  placing: boolean;
  paying: boolean;
  /** The server's refusal, verbatim, or a connection sentence. */
  error: string | null;
  /** A dismissed checkout: not an error, just what to do next. */
  note: string | null;
  placed: Placed | null;
  /** The nonce of the checkout being attempted, kept for a retry of exactly the same order. */
  attempt: { nonce: string; sig: string } | null;
  order: PublicQrOrder | null;
  orderState: LoadState;
  /** The last status read failed; what is on screen is the one before it. */
  stale: boolean;
  /** Said on the status page when the payment could not be confirmed from the browser. */
  statusNote: string | null;
  loadMenu: (token: string) => Promise<void>;
  add: (it: string) => void;
  remove: (it: string) => void;
  setQty: (it: string, n: number) => void;
  setCustomer: (patch: Partial<Customer>) => void;
  clearNotice: () => void;
  placeOrder: () => Promise<boolean>;
  openCheckout: () => Promise<void>;
  verify: (r: RazorpaySuccess) => Promise<void>;
  loadOrder: (id: string, secret: string) => Promise<void>;
  poll: (id: string, secret: string) => () => void;
};

const blank = () => ({
  token: null, menu: null, menuState: "idle" as LoadState, menuError: null, cart: {}, notice: null,
  customer: { name: "", phone: "", detail: "" }, placing: false, paying: false, error: null, note: null,
  placed: null, attempt: null, order: null, orderState: "idle" as LoadState, stale: false, statusNote: null,
});

// ---- pure helpers the screens preview with

/** How many of an item one order may carry: the server's per-item figure, never above the cap. */
export const limitOf = (item: PublicMenuItem): number => Math.max(0, Math.min(item.max, QR_MAX_QTY));

/** Whether the menu takes orders right now. */
export const orderable = (menu: PublicMenu | null): boolean => !!menu && menu.open.open && !menu.paused;

export function cartLines(menu: PublicMenu | null, cart: Record<string, number>): { item: PublicMenuItem; qty: number }[] {
  if (!menu) return [];
  return menu.items.filter((i) => (cart[i.it] ?? 0) > 0).map((item) => ({ item, qty: cart[item.it] }));
}
export const cartCount = (cart: Record<string, number>): number => Object.values(cart).reduce((s, n) => s + n, 0);
/** The preview total at the menu's prices. The server's quote is what is charged. */
export const cartTotal = (menu: PublicMenu | null, cart: Record<string, number>): number =>
  cartLines(menu, cart).reduce((s, l) => s + l.item.price * l.qty, 0);

/** What is missing or wrong in the customer's details, field by field. */
export function checkCustomer(c: Customer): CustomerErrors {
  const e: CustomerErrors = {};
  if (!c.name.trim()) e.name = "Enter your name, so the counter can call it out.";
  if (!c.phone.trim()) e.phone = "Enter your phone number.";
  else if (!normalizePhone(c.phone)) e.phone = customerPhoneRefusal(c.phone);
  return e;
}

// ---- the browser's side effects, each tolerant of a hostile environment

/** Remember the last order so a reload of its status page (or a return to it) still works. */
export function remember(entry: { orderId: string; secret: string; token: string }): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entry)); } catch { /* private mode: the fragment still has it */ }
}
/** The secret this phone was given for `orderId`, if it still has it. */
export function recall(orderId: string): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { orderId?: unknown; secret?: unknown };
    return v.orderId === orderId && typeof v.secret === "string" ? v.secret : null;
  } catch { return null; }
}

/** Move to another screen of the page without a reload. `OrderApp` listens for `popstate`. */
export function go(url: string): void {
  window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

let checkoutLoading: Promise<void> | null = null;
/** Razorpay's checkout.js, injected once and only when somebody presses Pay. */
export function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  checkoutLoading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CHECKOUT_JS;
    s.async = true;
    const fail = () => { s.remove(); checkoutLoading = null; reject(new Error("checkout.js did not load")); };
    s.onload = () => { if (window.Razorpay) resolve(); else fail(); };
    s.onerror = fail;
    document.head.appendChild(s);
  });
  return checkoutLoading;
}

/** The checkout's accent: the page's brand amber, the same in either theme. */
const BRAND_AMBER = "#E07B00";
/** Fifteen minutes, well inside the thirty an unpaid order is kept for. */
export const CHECKOUT_TIMEOUT_S = 900;
/** If the gateway never calls back at all (a sheet torn down under it), Pay comes back this long after its own timeout. */
export const CHECKOUT_BACKSTOP_MS = (CHECKOUT_TIMEOUT_S + 30) * 1000;
let backstop: ReturnType<typeof setTimeout> | undefined;
const clearBackstop = () => { if (backstop) clearTimeout(backstop); backstop = undefined; };

const bodyOf = (s: PublicOrderState) => {
  const lines = cartLines(s.menu, s.cart).map((l) => ({ it: l.item.it, qty: l.qty }));
  const detail = s.menu?.qr.mode === "deliver" ? s.customer.detail.trim() : "";
  const body = {
    name: s.customer.name.trim(),
    phone: normalizePhone(s.customer.phone) ?? s.customer.phone.trim(),
    ...(detail ? { detail } : {}),
    lines,
  };
  return { body, sig: JSON.stringify(body) };
};

export const usePublicOrder = create<PublicOrderState>()((set, get) => {
  /** Put an item's count to `n`, within the caps, saying which cap stopped it. */
  const put = (it: string, n: number) => {
    const s = get();
    const item = s.menu?.items.find((i) => i.it === it);
    if (!item) return;
    const cart = { ...s.cart };
    const want = Math.floor(n);
    if (want <= 0) { delete cart[it]; set({ cart, notice: null }); return; }
    if (!item.available || !orderable(s.menu)) return;
    if (!(it in cart) && Object.keys(cart).length >= QR_MAX_LINES) {
      set({ notice: `One order can carry at most ${QR_MAX_LINES} different items.` });
      return;
    }
    const cap = limitOf(item);
    let notice: string | null = null;
    if (want > cap) {
      notice = item.max < QR_MAX_QTY ? `Only ${item.max} of ${item.name} can be ordered right now.` : `One order can carry at most ${QR_MAX_QTY} of one item.`;
    }
    const q = Math.min(want, cap);
    if (q <= 0) delete cart[it]; else cart[it] = q;
    set({ cart, notice });
  };

  return {
    ...blank(),

    async loadMenu(token) {
      set({ token, menuState: get().menu && get().token === token ? "ready" : "loading" });
      try {
        const menu = await call(routes.publicQrMenu, { params: { token } });
        // Drop anything in the cart the menu no longer carries or no longer sells.
        const cart: Record<string, number> = {};
        for (const [it, n] of Object.entries(get().cart)) {
          const item = menu.items.find((i) => i.it === it);
          if (item?.available) cart[it] = Math.min(n, limitOf(item));
        }
        set({ menu, menuState: "ready", menuError: null, cart });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) set({ menu: null, menuState: "missing" });
        else set({ menuState: get().menu ? "ready" : "error", menuError: e instanceof ApiError ? e.message : NETWORK_MENU });
      }
    },

    add(it) { put(it, (get().cart[it] ?? 0) + 1); },
    remove(it) { put(it, (get().cart[it] ?? 0) - 1); },
    setQty(it, n) { put(it, n); },
    setCustomer(patch) { set({ customer: { ...get().customer, ...patch } }); },
    clearNotice() { set({ notice: null }); },

    async placeOrder() {
      const s = get();
      if (!s.token || s.placing || s.paying) return false;
      if (Object.keys(checkCustomer(s.customer)).length) return false;
      const { body, sig } = bodyOf(s);
      if (body.lines.length === 0) return false;
      // The same order already placed and still unpaid: reopen its checkout, never a second order.
      if (s.placed && s.placed.sig === sig && s.placed.order.status === "Awaiting payment") {
        await get().openCheckout();
        return true;
      }
      // A retry of the same attempt keeps its nonce, so the server can tell it is one order.
      const nonce = s.attempt?.sig === sig ? s.attempt.nonce : crypto.randomUUID();
      set({ placing: true, error: null, note: null, attempt: { nonce, sig } });
      try {
        const r = await call(routes.createQrOrder, { params: { token: s.token }, body: { nonce, ...body } });
        const placed: Placed = { ...r.result, sig };
        set({ placing: false, placed, order: r.result.order, attempt: null });
        remember({ orderId: r.result.order.id, secret: r.result.secret, token: s.token });
        await get().openCheckout();
        return true;
      } catch (e) {
        // A 409 says this attempt's order is already settled or lapsed: the next Pay is a new order.
        const settled = e instanceof ApiError && e.status === 409;
        set({ placing: false, error: e instanceof ApiError ? e.message : NETWORK_PLACE, ...(settled ? { attempt: null } : {}) });
        return false;
      }
    },

    async openCheckout() {
      const p = get().placed;
      if (!p) return;
      set({ paying: true, error: null, note: null });
      try { await loadRazorpay(); } catch {
        set({ paying: false, error: CHECKOUT_FAILED });
        return;
      }
      const Rzp = window.Razorpay!;
      const c = p.checkout;
      // The last reason the gateway gave for turning a payment down; its sheet stays open to try again.
      let failed: string | null = null;
      const finish = (patch: Partial<PublicOrderState>) => { clearBackstop(); set({ paying: false, ...patch }); };
      try {
        const rzp = new Rzp({
          key: c.keyId, order_id: c.orderId, amount: c.amount, currency: c.currency,
          name: get().menu?.outlet.name ?? p.order.outletName,
          description: `Order ${p.order.id}`,
          prefill: c.prefill,
          theme: { color: BRAND_AMBER },
          timeout: CHECKOUT_TIMEOUT_S,
          handler: (r) => { clearBackstop(); void get().verify(r); },
          modal: { ondismiss: () => { finish({ note: failed ?? PAYMENT_DISMISSED }); } },
        });
        rzp.on("payment.failed", (r) => {
          failed = paymentFailedNote(r.error?.description ?? r.error?.reason);
          set({ note: failed });
        });
        rzp.open();
      } catch {
        finish({ error: CHECKOUT_FAILED });
        return;
      }
      // Pay never stays locked: should the gateway say nothing at all, the button comes back.
      clearBackstop();
      backstop = setTimeout(() => {
        backstop = undefined;
        if (get().paying) set({ paying: false, note: failed ?? PAYMENT_DISMISSED });
      }, CHECKOUT_BACKSTOP_MS);
    },

    async verify(r) {
      const p = get().placed;
      const token = get().token;
      if (!p || !token) return;
      let statusNote: string | null = null;
      let order = p.order;
      try {
        const v = await call(routes.verifyQrPayment, {
          params: { id: p.order.id },
          body: { secret: p.secret, razorpay_order_id: r.razorpay_order_id, razorpay_payment_id: r.razorpay_payment_id, razorpay_signature: r.razorpay_signature },
        });
        order = v.result;
      } catch (e) {
        // The gateway has the money either way; its webhook settles the order if this did not.
        statusNote = e instanceof ApiError ? e.message : VERIFY_PENDING;
      }
      set({ paying: false, placed: null, cart: {}, order, orderState: "ready", statusNote, note: null, error: null });
      go(statusUrl(token, p.order.id, p.secret));
    },

    async loadOrder(id, secret) {
      if (get().order?.id !== id) set({ order: null, orderState: "loading" });
      try {
        const order = await call(routes.publicQrOrder, { params: { id }, query: { k: secret } });
        set({ order, orderState: "ready", stale: false });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) set({ order: null, orderState: "missing", stale: false });
        else if (get().order?.id === id) set({ stale: true });
        else set({ orderState: "error" });
      }
    },

    poll(id, secret) {
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let busy = false;
      let stopped = false;
      const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
      const done = () => {
        const s = get();
        return s.orderState === "missing" || (s.order?.id === id && QR_TERMINAL.has(s.order.status));
      };
      const schedule = () => {
        if (stopped || done() || hidden()) return;
        timer = setTimeout(() => { void tick(); }, Date.now() - started >= POLL_SLOW_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS);
      };
      const tick = async () => {
        timer = undefined;
        if (stopped || busy || hidden()) return;
        busy = true;
        try { await get().loadOrder(id, secret); } finally { busy = false; }
        schedule();
      };
      // A hidden tab asks nothing; coming back asks at once and picks the rhythm up again.
      const onVisible = () => { if (!hidden() && !timer && !busy && !stopped) void tick(); };
      document.addEventListener("visibilitychange", onVisible);
      void tick();
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        document.removeEventListener("visibilitychange", onVisible);
      };
    },
  };
});

/** Back to a first visit - for the suite. */
export function resetPublicOrder(): void {
  usePublicOrder.setState(blank());
  checkoutLoading = null;
  clearBackstop();
}
