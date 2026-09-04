import { create } from "zustand";
import { routes } from "@rch/contract";
import * as FX from "@rch/contract/fixtures";
import { ApiError, call } from "../api/client";
import { getAccessToken, onSessionLost, setAccessToken } from "../api/session";
import { refetch } from "../api/refetch";
import { applySnapshot } from "../api/wire";
import { IT, LOC, MENU, RCP } from "../data/master";
import {
  DAY_LABELS, seedBatch, seedBills, seedGrn, seedPo, seedPord, seedPrq, seedReq, seedRsv, seedSales,
  seedStock, seedTkt,
} from "../data/seed";
import { seedVendors } from "../data/vendors";
import type {
  Batch, Bill, DraftLine, DrawerState, Grn, LocKey, Payer, PordStatus, ProdOrder, PurchaseOrder,
  Requisition, StockRequest, Tender, Ticket, User, Vendor,
} from "../types";
import { basePrices, qty, resv } from "../lib/selectors";
import { bestBefore, fq, now, U } from "../lib/fmt";
import { applyTheme, nextTheme, readStoredTheme, storeTheme, type ThemePref } from "../lib/theme";
import { createProcurementSlice, type ProcurementSlice } from "./procurement";
import { createOpsSlice, type OpsSlice } from "./ops";

interface Seq { req: number; prq: number; po: number; pord: number; bat: number; vn: number }

export interface AppState extends ProcurementSlice, OpsSlice {
  user: User | null;
  /** Where the session is: no token, asking for one, fetching the snapshot, or usable. */
  auth: "signed-out" | "signing-in" | "loading" | "ready";
  mustChangePassword: boolean;
  stock: Record<LocKey, Record<string, number>>;
  rsv: Record<string, number>;
  ovr: Record<string, string>;
  prices: Record<"A" | "B", Record<string, number>>;
  menu: Record<string, string[]>;
  req: StockRequest[];
  tkt: Ticket[];
  prq: Requisition[];
  po: PurchaseOrder[];
  pord: ProdOrder[];
  batch: Batch[];
  bills: Bill[];
  grn: Grn[];
  vendors: Vendor[];
  sales: number[][];
  dayLabels: string[];
  seq: Seq;
  cart: Record<string, Record<string, number>>;
  draft: DraftLine[];
  prqDraft: DraftLine[];
  drawer: DrawerState | null;
  toast: string | null;
  shopFilter: LocKey | null;
  theme: ThemePref;

  login: (emp: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  /** Boot: turn the refresh cookie back into a session. Silent when there is no cookie. */
  restore: () => Promise<void>;
  loadSnapshot: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<boolean>;
  /** Local sign-in, kept for the tests and the Denied flow. */
  signIn: (id: string) => void;
  signOut: () => void;
  notify: (m: string) => void;
  openDrawer: (t: string, id: string) => void;
  closeDrawer: () => void;
  saveProfile: (p: Partial<User>) => Promise<void>;

  addToCart: (loc: LocKey, it: string, d?: number) => void;
  clearCart: (loc: LocKey) => void;
  pay: (loc: LocKey, tender: Tender, payer?: Payer) => Promise<void>;

  toggleAvail: (loc: LocKey, it: string) => Promise<void>;

  setDraft: (d: DraftLine[]) => void;
  /** The form-carrying writes answer `true` only once the server has taken them, so the screen
   *  can keep what the operator typed in front of them when it is refused. */
  submitRequest: (note: string, urgent: boolean) => Promise<boolean>;
  requestFromStore: (it: string, qty: number) => Promise<boolean>;
  cancelRequest: (id: string) => Promise<void>;

  approveRequest: (id: string, appr: number[], note: string) => Promise<boolean>;
  rejectRequest: (id: string, note: string) => Promise<boolean>;

  issueTicket: (reqId: string) => Promise<void>;
  /** `otp` is required from the collecting side; omit it only for a supervisor override. */
  handover: (tktId: string, otp?: string) => Promise<void>;
  receiveTicket: (tktId: string) => Promise<void>;

  setPrqDraft: (d: DraftLine[]) => void;
  sendRequisition: (note: string) => void;

  setOrderStatus: (id: string, st: PordStatus) => void;
  dispatchOrder: (id: string) => Promise<void>;
  makeProduct: (it: string, started: number, made?: number, note?: string) => void;
  distribute: (it: string, n: number, to: LocKey) => Promise<boolean>;

  savePrice: (list: "A" | "B", it: string, price: number) => Promise<void>;
  removeProduct: (loc: LocKey, it: string) => Promise<void>;
  addProduct: (loc: LocKey, it: string) => Promise<void>;
  setShopFilter: (l: LocKey | null) => void;
  setTheme: (t: ThemePref) => void;
  cycleTheme: () => void;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const hist = (who: string, s: string) => ({ s, who, t: now() });

export const useApp = create<AppState>((set, get) => ({
  user: null,
  auth: "signed-out",
  mustChangePassword: false,
  stock: clone(seedStock),
  rsv: seedRsv(),
  ovr: {},
  prices: basePrices(),
  menu: clone(MENU),
  req: clone(seedReq),
  tkt: clone(seedTkt),
  prq: clone(seedPrq),
  po: clone(seedPo),
  pord: clone(seedPord),
  batch: clone(seedBatch),
  bills: clone(seedBills),
  grn: clone(seedGrn),
  vendors: clone(seedVendors),
  sales: clone(seedSales),
  dayLabels: DAY_LABELS,
  seq: { req: 912, prq: 15, po: 142, pord: 30, bat: 1, vn: 5 },
  cart: {},
  draft: [],
  prqDraft: [],
  drawer: null,
  toast: null,
  shopFilter: null,
  theme: readStoredTheme(),

  login: async (emp, password) => {
    set({ auth: "signing-in" });
    try {
      const r = await call(routes.login, { body: { emp, password } });
      setAccessToken(r.accessToken);
      set({ user: r.user, mustChangePassword: r.mustChangePassword, auth: r.mustChangePassword ? "ready" : "loading" });
      if (!r.mustChangePassword) await get().loadSnapshot();
      return true;
    } catch (e) {
      set({ auth: "signed-out", user: null });
      get().notify(e instanceof ApiError ? e.message : "Could not reach the server — check the connection and try again.");
      return false;
    }
  },
  restore: async () => {
    // A token in memory means this tab already has a live session.
    if (getAccessToken()) return;
    set({ auth: "loading" });
    try {
      const r = await call(routes.refresh);
      setAccessToken(r.accessToken);
      set({ user: r.user, mustChangePassword: r.mustChangePassword });
      if (r.mustChangePassword) set({ auth: "ready" });
      else await get().loadSnapshot();
    } catch {
      // A first-time visitor has no cookie. That is not a session ending, so it
      // says nothing and simply shows the sign-in form.
      set({ auth: "signed-out", user: null });
    }
  },
  loadSnapshot: async () => {
    set({ auth: "loading" });
    try { applySnapshot(await call(routes.snapshot)); set({ auth: "ready" }); }
    catch (e) {
      // A 401 here has already signed the user out via onSessionLost; do not
      // pull the app back to "ready" behind that.
      if (get().user) set({ auth: "ready" });
      get().notify(e instanceof ApiError ? e.message : "Could not load the latest data — showing what is in memory.");
    }
  },
  logout: async () => {
    try { await call(routes.logout); } catch { /* the cookie is gone either way */ }
    setAccessToken(null);
    set({ user: null, auth: "signed-out", drawer: null, mustChangePassword: false });
  },
  changePassword: async (current, next) => {
    try {
      // The change revokes every token the tab is holding — the access token (still stamped
      // "must change password") and the refresh cookie behind it. The reply carries their
      // replacements, so take them before anything else calls the server.
      const r = await call(routes.changePassword, { body: { current, next } });
      setAccessToken(r.accessToken);
      set({ user: r.user, mustChangePassword: r.mustChangePassword, auth: "loading" });
      await get().loadSnapshot();
      get().notify("Password changed — you are signed in.");
      return true;
    } catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not change the password."); return false; }
  },

  // Test-only: the app signs in through `login()`. The registry the screens read is the
  // server's `UserMin[]`, which has no email or employee number, so the whole record a
  // signed-in person needs comes from the fixtures instead.
  signIn: (id) => set({ user: FX.USERS.find((u) => u.id === id) ?? null, drawer: null }),
  signOut: () => set({ user: null, drawer: null }),
  notify: (m) => {
    set({ toast: m });
    setTimeout(() => { if (get().toast === m) set({ toast: null }); }, 3400);
  },
  openDrawer: (t, id) => set({ drawer: { t, id } }),
  closeDrawer: () => set({ drawer: null }),
  saveProfile: async (p) => {
    try {
      const r = await call(routes.patchMe, { body: { n: p.n, e: p.e, ph: p.ph } });
      set({ user: r.user });
      get().notify("Profile saved");
    } catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not save the profile."); }
  },

  addToCart: (loc, it, d = 1) =>
    set((s) => {
      const c = { ...(s.cart[loc] ?? {}) };
      c[it] = (c[it] ?? 0) + d;
      if (c[it] <= 0) delete c[it];
      return { cart: { ...s.cart, [loc]: c } };
    }),
  clearCart: (loc) => set((s) => ({ cart: { ...s.cart, [loc]: {} } })),

  /**
   * One counter sale. Pricing, the payer rule, the cover check and the recipe explosion all
   * live on the server now (POST /bills); the cart is cleared only once it has answered, so
   * a refusal leaves the operator's scan exactly as it was.
   */
  pay: async (loc, tender, payer) => {
    const s = get();
    const cart = s.cart[loc] ?? {};
    const lines = Object.entries(cart).map(([it, qty]) => ({ it, qty }));
    if (!lines.length || !s.user) return;
    try {
      const r = await call(routes.pay, { body: { loc, tender, payer, lines } });
      set((x) => ({ cart: { ...x.cart, [loc]: {} } }));
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not take the bill — check the connection and try again.");
    }
  },

  toggleAvail: async (loc, it) => {
    try {
      const r = await call(routes.toggleAvail, { body: { loc, it } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not change what is on sale — check the connection and try again.");
    }
  },

  setDraft: (draft) => set({ draft }),
  /**
   * The request chain is the server's from here (Phase 3). Every action below builds a body,
   * posts it, repeats the sentence the server answered with, and refetches exactly what the
   * write said it changed. No rule is previewed locally — a refusal is the server's words.
   */
  submitRequest: async (note, urgent) => {
    const s = get();
    const lines = s.draft.filter((l) => l.it && l.qty > 0).map((l) => ({ it: l.it, qty: l.qty }));
    if (!lines.length || !s.user) { get().notify("Add at least one line with a quantity"); return false; }
    try {
      const r = await call(routes.createRequest, { body: { lines, note, urgent } });
      set({ draft: [] });                       // the draft is client-only state; clear it once it landed
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not send the request — check the connection and try again.");
      return false;
    }
  },
  requestFromStore: async (it, want) => {
    const s = get();
    if (!s.user) return false;
    try {
      const r = await call(routes.createRequest, {
        body: { lines: [{ it, qty: want }], note: `Raised from ${LOC[s.user.loc].n} stock screen`, urgent: false },
      });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not send the request — check the connection and try again.");
      return false;
    }
  },
  cancelRequest: async (id) => {
    try {
      const r = await call(routes.cancelRequest, { params: { id } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not cancel the request — check the connection and try again.");
    }
  },

  approveRequest: async (id, appr, note) => {
    try {
      const r = await call(routes.approveRequest, { params: { id }, body: { appr, note } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not save the approval — check the connection and try again.");
      return false;
    }
  },
  rejectRequest: async (id, note) => {
    try {
      const r = await call(routes.rejectRequest, { params: { id }, body: { note } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not save the rejection — check the connection and try again.");
      return false;
    }
  },

  issueTicket: async (reqId) => {
    try {
      const r = await call(routes.issueTicket, { params: { id: reqId } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not issue the ticket — check the connection and try again.");
    }
  },
  handover: async (tktId, otp) => {
    try {
      // The body is a strict object either way: `{ otp }` when the collector read one out,
      // `{}` for the labelled supervisor override. Omitting it entirely is a 400.
      const r = await call(routes.handover, { params: { id: tktId }, body: otp === undefined ? {} : { otp: otp.trim() } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not hand the ticket over — check the connection and try again.");
    }
  },
  receiveTicket: async (tktId) => {
    try {
      const r = await call(routes.receiveTicket, { params: { id: tktId } });
      set({ drawer: null });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not receive the ticket — check the connection and try again.");
    }
  },

  setPrqDraft: (prqDraft) => set({ prqDraft }),
  sendRequisition: (note) => {
    const s = get();
    if (!s.user) return;
    const lines = s.prqDraft.filter((l) => l.it && l.qty > 0)
      .map((l) => ({ it: l.it, qty: l.qty, appr: 0, ordered: 0 }));
    if (!lines.length) { get().notify("Add at least one line before sending"); return; }
    const id = "PRQ-2026-0" + (s.seq.prq + 1);
    set({
      seq: { ...s.seq, prq: s.seq.prq + 1 }, prqDraft: [],
      prq: [{ id, by: s.user.n, at: now(), lines, st: "Sent", note, hist: [hist(s.user.n, "Sent")] }, ...s.prq],
    });
    get().notify(`${id} sent to procurement`);
  },

  setOrderStatus: (id, st) => {
    const s = get();
    set({
      pord: s.pord.map((o) => o.id === id
        ? { ...o, st, hist: [...o.hist, hist(s.user?.n ?? "", st)] } : o),
    });
    get().notify(`${id} — ${st.toLowerCase()}`);
  },
  /** One order, one ticket, all or nothing — all of it the server's, on POST /prod-orders/:id/dispatch. */
  dispatchOrder: async (id) => {
    try {
      const r = await call(routes.dispatchProdOrder, { params: { id } });
      set({ drawer: null });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not dispatch the order — check the connection and try again.");
    }
  },
  makeProduct: (it, n, yielded, note) => {
    const s = get();
    if (!(n > 0)) { get().notify("Enter a quantity to make"); return; }
    // Ingredients go against what was started; only the good units reach the rack (UA-14).
    const made = yielded == null ? n : yielded;
    if (!(made >= 0) || made > n) {
      get().notify(`Yield cannot exceed the ${n} started`);
      return;
    }
    if (s.ovr["kitchen:" + it]) { get().notify(`${IT[it].n} is switched off in the kitchen`); return; }
    const r = RCP[it];
    if (!r) { get().notify(`${IT[it].n} has no recipe — it cannot be produced`); return; }
    // Production is the bridge between the two ledgers: finished goods only go up
    // because raw materials went down in the same transaction (C1).
    const short = r.l.find(([g, need]) => qty(s, "kitchen", g) - resv(s, "kitchen", g) < need * n);
    if (short) {
      const [g] = short;
      get().notify(
        `Kitchen is short of ${IT[g].n} — ${fq(qty(s, "kitchen", g) - resv(s, "kitchen", g), g)} ${U(g)} left`,
      );
      return;
    }
    const stock = clone(s.stock);
    r.l.forEach(([g, need]) => {
      stock.kitchen[g] = Math.round(((stock.kitchen[g] ?? 0) - need * n) * 1000) / 1000;
    });
    stock.kitchen[it] = Math.round(((stock.kitchen[it] ?? 0) + made) * 1000) / 1000;
    const id = "BAT-20260826-" + String(s.seq.bat + 1).padStart(2, "0");
    const bb = bestBefore(new Date(), IT[it].sl ?? 8);
    set({
      stock, seq: { ...s.seq, bat: s.seq.bat + 1 },
      batch: [{ id, it, qty: n, made, at: now(), bb, note }, ...s.batch],
    });
    get().notify(made === n
      ? `${id} — ${n} ${IT[it].n} made, best before ${bb}`
      : `${id} — ${made} of ${n} ${IT[it].n} yielded (${(((made - n) / n) * 100).toFixed(1)}%), best before ${bb}`);
  },
  /** A direct issue out of the kitchen: no request behind it, so the body carries the quantity. */
  distribute: async (it, n, to) => {
    try {
      const r = await call(routes.distribute, { body: { it, qty: n, to } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not send it out — check the connection and try again.");
      return false;
    }
  },

  /** The MRP ceiling is the server's to hold (PUT /prices/:list/:it); its refusal is the toast. */
  savePrice: async (list, it, price) => {
    try {
      const r = await call(routes.savePrice, { params: { list, it }, body: { price } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not save the price — check the connection and try again.");
    }
  },
  removeProduct: async (loc, it) => {
    try {
      const r = await call(routes.removeMenuItem, { params: { loc, it } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not take the product off the menu — check the connection and try again.");
    }
  },
  addProduct: async (loc, it) => {
    try {
      const r = await call(routes.addMenuItem, { params: { loc }, body: { it } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not add the product to the menu — check the connection and try again.");
    }
  },
  setShopFilter: (shopFilter) => set({ shopFilter }),
  setTheme: (theme) => {
    applyTheme(theme);
    storeTheme(theme);
    set({ theme });
  },
  cycleTheme: () => get().setTheme(nextTheme(get().theme)),

  ...createProcurementSlice(set as (p: Partial<AppState>) => void, get),
  ...createOpsSlice(set as (p: Partial<AppState>) => void, get),
}));

// A refresh that fails is the end of the session: drop the user rather than
// leave the screens showing data nobody is signed in to see.
onSessionLost(() => {
  useApp.setState({ user: null, auth: "signed-out" });
  useApp.getState().notify("Your session ended — sign in again.");
});
