import { create } from "zustand";
import { routes, StockLocSchema } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { getAccessToken, onSessionLost, setAccessToken } from "../api/session";
import { refetch } from "../api/refetch";
import { applySnapshot } from "../api/wire";
import { LOC } from "../data/master";
import type {
  Batch, Bill, CreditResponse, DraftLine, DrawerState, Grn, LocKey, Payer, PordStatus, ProdOrder,
  PurchaseOrder, Requisition, StockLedgerRow, StockLoc, StockRequest, Tender, Ticket, User, Vendor,
} from "../types";
import { applyTheme, nextTheme, readStoredTheme, storeTheme, type ThemePref } from "../lib/theme";
import { createProcurementSlice, type ProcurementSlice } from "./procurement";
import { createOpsSlice, type OpsSlice } from "./ops";

export interface AppState extends ProcurementSlice, OpsSlice {
  user: User | null;
  /** Where the session is: no token, asking for one, fetching the snapshot, usable — or signed
   *  in with nothing to show. `"failed"` is the last one: the credentials are good and the
   *  snapshot is not, so there is no item master, no locations and no menus, and every screen
   *  would read `LOC[loc].n` off an empty object. It is a state of its own rather than a toast
   *  over "ready" because the difference is whether the app can be used at all. */
  auth: "signed-out" | "signing-in" | "loading" | "ready" | "failed";
  mustChangePassword: boolean;
  /** Quarantine is in here: the store keeper sees what a goods receipt turned away. It is a
   *  place stock is *reported*, never one an operator acts at, so no write body admits it. */
  stock: Record<StockLoc, Record<string, number>>;
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

  /** Withdraw a ticket nobody collected: the hold goes back and so does the document behind it.
   *  Answers `true` only once the server has taken it, so the drawer can keep the reason. */
  cancelTicket: (tktId: string, reason: string) => Promise<boolean>;

  setPrqDraft: (d: DraftLine[]) => void;
  /** The central store's ask (POST /requisitions). Answers `true` only once the server has
   *  taken it, so the draft and its note survive a refusal. */
  sendRequisition: (note: string) => Promise<boolean>;

  setOrderStatus: (id: string, st: PordStatus) => Promise<void>;
  dispatchOrder: (id: string) => Promise<void>;
  /** Answers `true` only once the batch is on the server, so the tile can keep the kitchen's
   *  typing in front of them when it is refused. */
  makeProduct: (it: string, started: number, made?: number, note?: string) => Promise<boolean>;
  distribute: (it: string, n: number, to: LocKey) => Promise<boolean>;

  savePrice: (list: "A" | "B", it: string, price: number) => Promise<void>;
  removeProduct: (loc: LocKey, it: string) => Promise<void>;
  addProduct: (loc: LocKey, it: string) => Promise<void>;
  /** The central store's ledger over a window, from the server's own sum of `stock_moves`.
   *  Answers `null` and toasts when the read fails — never `[]`, which is a real answer meaning
   *  the location carries no line — so the report can say which of the two happened rather than
   *  reporting an outage as an empty store. It leaves the screen usable either way. */
  readStockLedger: (loc: StockLoc, days: number) => Promise<StockLedgerRow[] | null>;
  /** What one payer has put on credit this calendar month, hospital-wide — the number the
   *  server will refuse on. `null` when the read fails, so the till can say "checking…" rather
   *  than print a zero, which would read as "no credit taken". */
  readCredit: (payer: Payer) => Promise<CreditResponse | null>;

  setShopFilter: (l: LocKey | null) => void;
  setTheme: (t: ThemePref) => void;
  cycleTheme: () => void;
}

/** Every collection starts empty and is filled by `applySnapshot`. Nothing here is data: the
 *  screens do not render until `auth` reaches "ready", which only a snapshot can do. `stock` is
 *  exhaustive because every `stock[loc][it]` read would otherwise throw on a missing location. */
const EMPTY_STOCK = Object.fromEntries(StockLocSchema.options.map((l) => [l, {}])) as Record<StockLoc, Record<string, number>>;

export const useApp = create<AppState>((set, get) => ({
  user: null,
  auth: "signed-out",
  mustChangePassword: false,
  stock: EMPTY_STOCK, rsv: {}, ovr: {}, prices: { A: {}, B: {} }, menu: {},
  req: [], tkt: [], prq: [], po: [], pord: [], batch: [], bills: [], grn: [], vendors: [],
  sales: [], dayLabels: [],
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
      if (!get().user) {
        get().notify(e instanceof ApiError ? e.message : "Could not reach the server — check the connection and try again.");
        return;
      }
      // Whether there is anything left to show is the whole question. The registries start
      // **empty** and only a snapshot fills them (`data/master.ts`), so before the first one
      // lands there is no "what is in memory": the counter's own screen reads `LOC[loc].n` and
      // would throw straight into the error boundary. Say the app could not start and let the
      // shell offer the retry, rather than announcing data that does not exist.
      if (Object.keys(LOC).length === 0) { set({ auth: "failed" }); return; }
      // The master is already hydrated, so the last snapshot is still on screen and usable —
      // this was a refresh that did not land, not a start that did not happen.
      set({ auth: "ready" });
      get().notify(e instanceof ApiError ? e.message : "Could not refresh — showing the last data loaded.");
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
  /** A ticket withdrawn before anyone collected against it (POST /tickets/:id/cancel). The
   *  hold comes back and so does the document behind it; nothing moves, because nothing had. */
  cancelTicket: async (tktId, reason) => {
    try {
      const r = await call(routes.cancelTicket, { params: { id: tktId }, body: { reason } });
      set({ drawer: null });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not cancel the ticket — check the connection and try again.");
      return false;
    }
  },

  setPrqDraft: (prqDraft) => set({ prqDraft }),
  /** Buying starts here (POST /requisitions). A line with no quantity on it is client-side
   *  noise rather than something to send and have refused, so it is dropped before the post;
   *  the draft itself is cleared only once the server has taken it. */
  sendRequisition: async (note) => {
    const lines = get().prqDraft.filter((l) => l.it && l.qty > 0).map((l) => ({ it: l.it, qty: l.qty }));
    try {
      const r = await call(routes.createRequisition, { body: { lines, note } });
      set({ prqDraft: [] });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not send the requisition — check the connection and try again.");
      return false;
    }
  },

  /** One press on the board (POST /prod-orders/:id/status); the transition table is the
   *  server's to enforce and `canMoveOrder` is what decides which button was drawn. */
  setOrderStatus: async (id, st) => {
    try {
      const r = await call(routes.setOrderStatus, { params: { id }, body: { st } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not move the order on — check the connection and try again.");
    }
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
  /**
   * A batch (POST /batches). Every rule that used to live here is the server's: the quantity,
   * the yield, the kitchen's switch, the recipe, and whether the rack can cover it. The
   * ingredients come off and the finished units go on inside one transaction there (C1), so
   * there is nothing left to do here but ask and report.
   */
  makeProduct: async (it, started, made, note) => {
    try {
      const r = await call(routes.makeBatch, {
        body: { it, started, ...(made == null ? {} : { made }), ...(note ? { note } : {}) },
      });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not record the batch — check the connection and try again.");
      return false;
    }
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
  /**
   * The two figures the browser cannot compute for itself. Both are reads, not writes, so
   * neither notifies a success nor refetches anything — they answer the caller and nothing else.
   * They live here rather than in the screens because `.oxlintrc.json` makes `api/client` a
   * forbidden import under `roles/` and `pages/`: a screen that fetches for itself is a screen
   * that cannot be tested without a network.
   */
  readStockLedger: async (loc, days) => {
    try { return (await call(routes.stockLedger, { query: { loc, days } })).rows; }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read the stock ledger."); return null; }
  },
  readCredit: async (payer) => {
    // Silent on failure on purpose: this runs on every payer selection at a busy till, and a
    // toast per keystroke would bury the sentence that matters. The server still refuses.
    try { return await call(routes.creditReport, { params: { kind: payer.kind, id: payer.id } }); }
    catch { return null; }
  },

  setShopFilter: (shopFilter) => set({ shopFilter }),
  setTheme: (theme) => {
    applyTheme(theme);
    storeTheme(theme);
    set({ theme });
  },
  cycleTheme: () => get().setTheme(nextTheme(get().theme)),

  ...createProcurementSlice(get),
  // The ops slice writes nothing directly any more — every action of it posts and refetches —
  // so it takes only the reader.
  ...createOpsSlice(get),
}));

// A refresh that fails is the end of the session: drop the user rather than
// leave the screens showing data nobody is signed in to see.
onSessionLost(() => {
  useApp.setState({ user: null, auth: "signed-out" });
  useApp.getState().notify("Your session ended — sign in again.");
});
