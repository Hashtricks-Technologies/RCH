import { create } from "zustand";
import { routes } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { getAccessToken, onSessionLost, setAccessToken } from "../api/session";
import { applySnapshot } from "../api/wire";
import { IT, LOC, MENU, RCP, USERS } from "../data/master";
import {
  DAY_LABELS, seedBatch, seedBills, seedGrn, seedPo, seedPord, seedPrq, seedReq, seedRsv, seedSales,
  seedStock, seedTkt,
} from "../data/seed";
import { seedVendors } from "../data/vendors";
import type {
  Batch, Bill, DraftLine, DrawerState, Grn, LocKey, Payer, PordStatus, ProdOrder, PurchaseOrder,
  Requisition, StockRequest, Ticket, TktLine, User, Vendor,
} from "../types";
import { basePrices, freeToPromise, priceOf, qty, resv } from "../lib/selectors";
import { bestBefore, fq, now, U, makeOtp } from "../lib/fmt";
import { applyTheme, nextTheme, readStoredTheme, storeTheme, type ThemePref } from "../lib/theme";
import { createProcurementSlice, type ProcurementSlice } from "./procurement";
import { createOpsSlice, type OpsSlice } from "./ops";

interface Seq { req: number; tkt: number; bill: number; prq: number; po: number; pord: number; bat: number; vn: number }

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
  pay: (loc: LocKey, tender: string, payer?: Payer) => void;

  toggleAvail: (loc: LocKey, it: string) => void;

  setDraft: (d: DraftLine[]) => void;
  submitRequest: (note: string, urgent: boolean) => void;
  requestFromStore: (it: string, qty: number) => void;
  cancelRequest: (id: string) => void;

  approveRequest: (id: string, appr: number[], note: string) => void;
  rejectRequest: (id: string, note: string) => void;

  issueTicket: (reqId: string) => void;
  /** `otp` is required from the collecting side; omit it only for a supervisor override. */
  handover: (tktId: string, otp?: string) => void;
  receiveTicket: (tktId: string) => void;

  setPrqDraft: (d: DraftLine[]) => void;
  sendRequisition: (note: string) => void;

  setOrderStatus: (id: string, st: PordStatus) => void;
  dispatchOrder: (id: string) => void;
  makeProduct: (it: string, started: number, made?: number, note?: string) => void;
  distribute: (it: string, n: number, to: LocKey) => void;

  savePrice: (list: "A" | "B", it: string, price: number) => void;
  removeProduct: (loc: LocKey, it: string) => void;
  addProduct: (loc: LocKey, it: string) => void;
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
  seq: { req: 912, tkt: 440, bill: 1187, prq: 15, po: 142, pord: 30, bat: 1, vn: 5 },
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

  signIn: (id) => set({ user: USERS.find((u) => u.id === id) ?? null, drawer: null }),
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

  pay: (loc, tender, payer) => {
    const s = get();
    const cart = s.cart[loc] ?? {};
    const keys = Object.keys(cart);
    if (!keys.length || !s.user) return;
    const NEEDS_PAYER: Record<string, string> = {
      "Patient bill": "patient", "Staff credit": "staff member", Dept: "department",
    };
    if (NEEDS_PAYER[tender] && !payer) {
      get().notify(`Choose a ${NEEDS_PAYER[tender]} before taking a ${tender.toLowerCase()}`);
      return;
    }
    const stock = clone(s.stock);
    let tot = 0, tax = 0;
    const lines = keys.map((it) => {
      const { p } = priceOf(s, loc, it);
      const amt = p * cart[it];
      tot += amt;
      tax += amt - amt / (1 + IT[it].gst / 100);
      if (IT[it].t === "MTO") {
        for (const [g, need] of RCP[it].l)
          stock[loc][g] = Math.round(((stock[loc][g] ?? 0) - need * cart[it]) * 1000) / 1000;
      } else {
        stock[loc][it] = Math.round(((stock[loc][it] ?? 0) - cart[it]) * 1000) / 1000;
      }
      return { it, qty: cart[it], rate: p };
    });
    const no = "CF/" + (s.seq.bill + 1);
    set({
      stock, seq: { ...s.seq, bill: s.seq.bill + 1 },
      cart: { ...s.cart, [loc]: {} },
      bills: [{ no, loc, opr: s.user.n, oprCol: s.user.col, tot, tax, t: now(), pay: tender, lines, payer }, ...s.bills],
    });
    get().notify(payer
      ? `Bill ${no} · ₹${tot.toFixed(2)} posted to ${payer.name}`
      : `Bill ${no} · ₹${tot.toFixed(2)} ${tender === "Cash" ? "collected" : "settled by " + tender.toLowerCase()} at ${LOC[loc].n}`);
  },

  toggleAvail: (loc, it) =>
    set((s) => {
      const k = loc + ":" + it;
      const ovr = { ...s.ovr };
      if (ovr[k]) delete ovr[k];
      else ovr[k] = "switched off manually";
      setTimeout(() => get().notify(`${IT[it].n} ${ovr[k] ? "switched off" : "switched on"} at ${LOC[loc].n}`), 0);
      return { ovr };
    }),

  setDraft: (draft) => set({ draft }),
  submitRequest: (note, urgent) => {
    const s = get();
    if (!s.user) return;
    const lines = s.draft.filter((l) => l.it && l.qty > 0).map((l) => ({ it: l.it, qty: l.qty, appr: 0 }));
    if (!lines.length) { get().notify("Add at least one line with a quantity"); return; }
    const id = "REQ-2026-0" + (s.seq.req + 1);
    set({
      seq: { ...s.seq, req: s.seq.req + 1 }, draft: [],
      req: [...s.req, {
        id, from: s.user.loc, by: s.user.n, at: now(), lines,
        st: "Request sent", ticket: null, mgrNote: note, urg: urgent,
        hist: [hist(s.user.n, "Request sent")],
      }],
    });
    get().notify(`${id} sent to the outlet manager — ${lines.length} line${lines.length > 1 ? "s" : ""}`);
  },
  requestFromStore: (it, want) => {
    const s = get();
    if (!s.user) return;
    if (!(want > 0)) { get().notify("Enter a quantity to request"); return; }
    const id = "REQ-2026-0" + (s.seq.req + 1);
    set({
      seq: { ...s.seq, req: s.seq.req + 1 },
      req: [...s.req, {
        id, from: s.user.loc, by: s.user.n, at: now(),
        lines: [{ it, qty: want, appr: 0 }],
        st: "Request sent", ticket: null,
        mgrNote: `Raised from ${LOC[s.user.loc].n} stock screen`,
        hist: [hist(s.user.n, "Request sent")],
      }],
    });
    get().notify(`${id} raised for ${want} ${IT[it].n} — with the outlet manager now`);
  },
  cancelRequest: (id) =>
    set((s) => {
      const req = s.req.map((r) => {
        if (r.id !== id || (r.st !== "Draft" && r.st !== "Request sent")) return r;
        return { ...r, st: "Cancelled" as const, hist: [...r.hist, hist(s.user?.n ?? "", "Cancelled")] };
      });
      setTimeout(() => get().notify(`${id} cancelled`), 0);
      return { req };
    }),

  approveRequest: (id, appr, note) => {
    const s = get();
    const r = s.req.find((x) => x.id === id);
    if (!r || !s.user) return;
    // Never promise more than the counter asked for, nor more than is still free
    // to promise once other approvals and open tickets are netted off (C6).
    const lines = r.lines.map((l, i) => {
      const asked = Number.isFinite(appr[i]) ? appr[i] : 0;
      const free = freeToPromise(s, "store", l.it);
      const ok = Math.max(0, Math.min(l.qty, asked, free));
      return { ...l, appr: ok, short: Math.round((l.qty - ok) * 1000) / 1000 };
    });
    const total = lines.reduce((t, l) => t + l.appr, 0);
    const st = total === 0 ? "Rejected" : lines.every((l) => l.appr === l.qty) ? "Manager approved" : "Partially approved";
    const trimmed = lines.some((l, i) => l.appr < Math.min(l.qty, Number.isFinite(appr[i]) ? appr[i] : 0));
    set({
      req: s.req.map((x) => x.id === id
        ? { ...x, lines, st, mgrNote: note, apprBy: s.user!.n, hist: [...x.hist, hist(s.user!.n, st)] } : x),
    });
    if (trimmed) {
      get().notify(`${id} trimmed — the central store cannot cover the full quantity`);
      return;
    }
    get().notify(st === "Rejected" ? `${id} rejected — no ticket will be issued`
      : `${id} ${st.toLowerCase()} and forwarded to the store keeper`);
  },
  rejectRequest: (id, note) => {
    const s = get();
    if (!s.user) return;
    if (!note.trim()) { get().notify("Give a reason — the counter sees it on the request"); return; }
    set({
      req: s.req.map((x) => x.id === id
        ? { ...x, st: "Rejected" as const, mgrNote: note, apprBy: s.user!.n,
            hist: [...x.hist, hist(s.user!.n, "Rejected")] } : x),
    });
    get().notify(`${id} rejected`);
  },

  issueTicket: (reqId) => {
    const s = get();
    const r = s.req.find((x) => x.id === reqId);
    if (!r || !s.user) return;
    const lines = r.lines.filter((l) => l.appr > 0).map((l) => ({ it: l.it, qty: l.appr }));
    if (!lines.length) { get().notify("Nothing approved on this request"); return; }
    const short = lines.find((l) => qty(s, "store", l.it) - resv(s, "store", l.it) < l.qty);
    if (short) { get().notify(`Not enough ${IT[short.it].n} available to promise`); return; }
    const id = "TKT-0" + (s.seq.tkt + 1);
    const rsv = { ...s.rsv };
    lines.forEach((l) => { rsv["store:" + l.it] = (rsv["store:" + l.it] ?? 0) + l.qty; });
    set({
      rsv, seq: { ...s.seq, tkt: s.seq.tkt + 1 },
      tkt: [...s.tkt, { id, req: reqId, from: "store", to: r.from, lines, st: "Issued", otp: makeOtp(s.seq.tkt + 1) }],
      req: s.req.map((x) => x.id === reqId
        ? { ...x, ticket: id, st: "Ticket issued" as const, hist: [...x.hist, hist(s.user!.n, "Ticket issued")] } : x),
    });
    get().notify(`${id} issued — ${LOC[r.from].n} can collect against this ticket`);
  },
  handover: (tktId, otp) => {
    const s = get();
    const t = s.tkt.find((x) => x.id === tktId);
    if (!t || t.st !== "Issued") return;
    if (otp !== undefined && otp.trim() !== t.otp) {
      s.notify(`That OTP does not match ${tktId}. Ask the collector to read it again.`);
      return;
    }
    const stock = clone(s.stock);
    const rsv = { ...s.rsv };
    t.lines.forEach((l) => {
      stock[t.from][l.it] = Math.round(((stock[t.from][l.it] ?? 0) - l.qty) * 1000) / 1000;
      rsv[t.from + ":" + l.it] = Math.max(0, (rsv[t.from + ":" + l.it] ?? 0) - l.qty);
    });
    set({
      stock, rsv,
      tkt: s.tkt.map((x) => x.id === tktId ? { ...x, st: "Collected" as const } : x),
      req: s.req.map((x) => x.id === t.req
        ? { ...x, st: "Collected" as const, hist: [...x.hist, hist(s.user?.n ?? "", "Collected")] } : x),
    });
    get().notify(`${tktId} handed over — stock is in transit to ${LOC[t.to].n}`);
  },
  receiveTicket: (tktId) => {
    const s = get();
    const t = s.tkt.find((x) => x.id === tktId);
    if (!t || t.st !== "Collected") return;
    const stock = clone(s.stock);
    t.lines.forEach((l) => {
      stock[t.to][l.it] = Math.round(((stock[t.to][l.it] ?? 0) + l.qty) * 1000) / 1000;
    });
    set({
      stock, drawer: null,
      tkt: s.tkt.map((x) => x.id === tktId ? { ...x, st: "Received" as const } : x),
      req: s.req.map((x) => x.id === t.req
        ? { ...x, st: "Closed" as const, hist: [...x.hist, hist(s.user?.n ?? "", "Received")] } : x),
    });
    get().notify(`Received at ${LOC[t.to].n} — stock is on the shelf`);
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
  dispatchOrder: (id) => {
    const s = get();
    const o = s.pord.find((x) => x.id === id);
    if (!o) return;
    // One order, one ticket. Dispatching twice would raise a second ticket for
    // stock already promised, which is how half an order ends up in two places.
    if (o.st === "Dispatched") {
      get().notify(`${id} has already gone out — it is on one ticket to ${LOC[o.from].n}`);
      return;
    }
    if (o.st === "Declined") { get().notify(`${id} was declined — it cannot be dispatched`); return; }
    // Fold a repeated item into a single line so the cover check is made against
    // the whole quantity the order asks for, not one line of it at a time.
    const lines: TktLine[] = [];
    o.lines.forEach((l) => {
      const seen = lines.find((x) => x.it === l.it);
      if (seen) seen.qty = Math.round((seen.qty + l.qty) * 1000) / 1000;
      else lines.push({ it: l.it, qty: l.qty });
    });
    if (!lines.length) { get().notify(`${id} has no items on it`); return; }
    // All or nothing: a part-dispatched order leaves the outlet guessing what is
    // still coming, so every item short is named and nothing moves.
    const short = lines.filter((l) => qty(s, "kitchen", l.it) - resv(s, "kitchen", l.it) < l.qty);
    if (short.length) {
      get().notify(
        `Nothing dispatched — the kitchen is short of ${short.map((l) => IT[l.it].n).join(", ")}`,
      );
      return;
    }
    // Approval authorises, the scan moves: reserve here, deduct at handover.
    const rsv = { ...s.rsv };
    lines.forEach((l) => {
      rsv["kitchen:" + l.it] = (rsv["kitchen:" + l.it] ?? 0) + l.qty;
    });
    const tid = "TKT-0" + (s.seq.tkt + 1);
    set({
      rsv, seq: { ...s.seq, tkt: s.seq.tkt + 1 }, drawer: null,
      tkt: [...s.tkt, { id: tid, req: id, from: "kitchen", to: o.from, lines, st: "Issued", otp: makeOtp(s.seq.tkt + 1) }],
      pord: s.pord.map((x) => x.id === id
        ? { ...x, st: "Dispatched" as const, hist: [...x.hist, hist(s.user?.n ?? "", "Dispatched")] } : x),
    });
    get().notify(
      `${tid} issued — all ${lines.length} item${lines.length === 1 ? "" : "s"} of ${id} reserved for ${LOC[o.from].n}`,
    );
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
  distribute: (it, n, to) => {
    const s = get();
    if (!(n > 0)) { get().notify("Enter a quantity"); return; }
    // Stock that arrives somewhere it cannot be sold is stock lost (M9).
    const listed = s.menu[to] ?? MENU[to] ?? [];
    if (LOC[to].type === "Outlet" && !listed.includes(it)) {
      get().notify(`${IT[it].n} is not listed at ${LOC[to].n} — add it to that menu first`);
      return;
    }
    const free = qty(s, "kitchen", it) - resv(s, "kitchen", it);
    if (free < n) { get().notify(`Kitchen has only ${fq(free, it)} ${U(it)} free to promise`); return; }
    const tid = "TKT-0" + (s.seq.tkt + 1);
    set({
      rsv: { ...s.rsv, ["kitchen:" + it]: (s.rsv["kitchen:" + it] ?? 0) + n },
      seq: { ...s.seq, tkt: s.seq.tkt + 1 },
      tkt: [...s.tkt, { id: tid, req: "Direct issue", from: "kitchen", to, lines: [{ it, qty: n }], st: "Issued", otp: makeOtp(s.seq.tkt + 1) }],
    });
    get().notify(`${tid} issued — ${n} ${IT[it].n} reserved for ${LOC[to].n}`);
  },

  savePrice: (list, it, price) => {
    const mrp = IT[it]?.mrp;
    if (mrp != null && price > mrp) {
      get().notify(`Refused — printed MRP of ₹${mrp} is a hard ceiling for ${IT[it].n}`);
      return;
    }
    set((s) => ({ prices: { ...s.prices, [list]: { ...s.prices[list], [it]: price } } }));
    get().notify(`${IT[it].n} priced at ₹${price} on list ${list}`);
  },
  removeProduct: (loc, it) => {
    set((s) => ({ menu: { ...s.menu, [loc]: (s.menu[loc] ?? []).filter((x) => x !== it) } }));
    get().notify(`${IT[it].n} removed from ${LOC[loc].n}`);
  },
  addProduct: (loc, it) => {
    const s = get();
    const listed = s.menu[loc] ?? MENU[loc] ?? [];
    if (listed.includes(it)) { get().notify(`${IT[it].n} is already listed at ${LOC[loc].n}`); return; }
    set({ menu: { ...s.menu, [loc]: [...listed, it] } });
    get().notify(`${IT[it].n} listed at ${LOC[loc].n}`);
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
