import { create } from "zustand";
import { IT, LOC, MENU, RCP, USERS } from "./data/master";
import {
  DAY_LABELS, seedBatch, seedBills, seedPo, seedPord, seedPrq, seedReq, seedSales, seedStock, seedTkt,
} from "./data/seed";
import type {
  Batch, Bill, DraftLine, DrawerState, LocKey, PordStatus, ProdOrder, PurchaseOrder,
  Requisition, StockRequest, Ticket, User,
} from "./types";
import { basePrices, priceOf, qty, resv } from "./lib/selectors";
import { now } from "./lib/fmt";

interface Seq { req: number; tkt: number; bill: number; prq: number; po: number; pord: number; bat: number }

export interface AppState {
  user: User | null;
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
  sales: number[][];
  dayLabels: string[];
  seq: Seq;
  cart: Record<string, Record<string, number>>;
  draft: DraftLine[];
  prqDraft: DraftLine[];
  drawer: DrawerState | null;
  toast: string | null;
  shopFilter: LocKey | null;

  signIn: (id: string) => void;
  signOut: () => void;
  notify: (m: string) => void;
  openDrawer: (t: string, id: string) => void;
  closeDrawer: () => void;
  saveProfile: (p: Partial<User>) => void;

  addToCart: (loc: LocKey, it: string, d?: number) => void;
  clearCart: (loc: LocKey) => void;
  pay: (loc: LocKey, tender: string) => void;

  toggleAvail: (loc: LocKey, it: string) => void;

  setDraft: (d: DraftLine[]) => void;
  submitRequest: (note: string, urgent: boolean) => void;
  cancelRequest: (id: string) => void;

  approveRequest: (id: string, appr: number[], note: string) => void;
  rejectRequest: (id: string, note: string) => void;

  issueTicket: (reqId: string) => void;
  handover: (tktId: string) => void;
  receiveTicket: (tktId: string) => void;

  setPrqDraft: (d: DraftLine[]) => void;
  sendRequisition: (note: string) => void;

  orderRequisition: (prqId: string, rates: number[], vendor: string, eta: string) => void;
  declineRequisition: (prqId: string) => void;
  receiveRequisition: (prqId: string) => void;

  setOrderStatus: (id: string, st: PordStatus) => void;
  dispatchOrder: (id: string) => void;
  makeProduct: (it: string, n: number) => void;
  distribute: (it: string, n: number, to: LocKey) => void;

  savePrice: (list: "A" | "B", it: string, price: number) => void;
  removeProduct: (loc: LocKey, it: string) => void;
  setShopFilter: (l: LocKey | null) => void;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const hist = (who: string, s: string) => ({ s, who, t: now() });

export const useApp = create<AppState>((set, get) => ({
  user: null,
  stock: clone(seedStock),
  rsv: {},
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
  sales: clone(seedSales),
  dayLabels: DAY_LABELS,
  seq: { req: 912, tkt: 440, bill: 1187, prq: 13, po: 142, pord: 30, bat: 1 },
  cart: {},
  draft: [],
  prqDraft: [],
  drawer: null,
  toast: null,
  shopFilter: null,

  signIn: (id) => set({ user: USERS.find((u) => u.id === id) ?? null, drawer: null }),
  signOut: () => set({ user: null, drawer: null }),
  notify: (m) => {
    set({ toast: m });
    setTimeout(() => { if (get().toast === m) set({ toast: null }); }, 3400);
  },
  openDrawer: (t, id) => set({ drawer: { t, id } }),
  closeDrawer: () => set({ drawer: null }),
  saveProfile: (p) => set((s) => (s.user ? { user: { ...s.user, ...p } } : {})),

  addToCart: (loc, it, d = 1) =>
    set((s) => {
      const c = { ...(s.cart[loc] ?? {}) };
      c[it] = (c[it] ?? 0) + d;
      if (c[it] <= 0) delete c[it];
      return { cart: { ...s.cart, [loc]: c } };
    }),
  clearCart: (loc) => set((s) => ({ cart: { ...s.cart, [loc]: {} } })),

  pay: (loc, tender) => {
    const s = get();
    const cart = s.cart[loc] ?? {};
    const keys = Object.keys(cart);
    if (!keys.length || !s.user) return;
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
      bills: [{ no, loc, opr: s.user.n, oprCol: s.user.col, tot, tax, t: now(), pay: tender, lines }, ...s.bills],
    });
    get().notify(`Bill ${no} · ₹${tot.toFixed(2)} collected at ${LOC[loc].n}`);
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
    const lines = r.lines.map((l, i) => ({
      ...l, appr: Math.max(0, Math.min(l.qty, Number.isFinite(appr[i]) ? appr[i] : 0)),
    }));
    const total = lines.reduce((t, l) => t + l.appr, 0);
    const st = total === 0 ? "Rejected" : lines.every((l) => l.appr === l.qty) ? "Manager approved" : "Partially approved";
    set({
      req: s.req.map((x) => x.id === id
        ? { ...x, lines, st, mgrNote: note, hist: [...x.hist, hist(s.user!.n, st)] } : x),
    });
    get().notify(st === "Rejected" ? `${id} rejected — no ticket will be issued`
      : `${id} ${st.toLowerCase()} and forwarded to the store keeper`);
  },
  rejectRequest: (id, note) => {
    const s = get();
    if (!s.user) return;
    set({
      req: s.req.map((x) => x.id === id
        ? { ...x, st: "Rejected" as const, mgrNote: note, hist: [...x.hist, hist(s.user!.n, "Rejected")] } : x),
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
      tkt: [...s.tkt, { id, req: reqId, from: "store", to: r.from, lines, st: "Issued" }],
      req: s.req.map((x) => x.id === reqId
        ? { ...x, ticket: id, st: "Ticket issued" as const, hist: [...x.hist, hist(s.user!.n, "Ticket issued")] } : x),
    });
    get().notify(`${id} issued — ${LOC[r.from].n} can collect against this ticket`);
  },
  handover: (tktId) => {
    const s = get();
    const t = s.tkt.find((x) => x.id === tktId);
    if (!t || t.st !== "Issued") return;
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
    const lines = s.prqDraft.filter((l) => l.it && l.qty > 0).map((l) => ({ it: l.it, qty: l.qty }));
    if (!lines.length) { get().notify("Add at least one line before sending"); return; }
    const id = "PRQ-2026-0" + (s.seq.prq + 1);
    set({
      seq: { ...s.seq, prq: s.seq.prq + 1 }, prqDraft: [],
      prq: [{ id, by: s.user.n, at: now(), lines, st: "Sent", note }, ...s.prq],
    });
    get().notify(`${id} sent to procurement`);
  },

  orderRequisition: (prqId, rates, vendor, eta) => {
    const s = get();
    const p = s.prq.find((x) => x.id === prqId);
    if (!p || p.st !== "Sent") return;
    const lines = p.lines.map((l, i) => ({
      it: l.it, qty: l.qty,
      rate: Number.isFinite(rates[i]) && rates[i] > 0 ? rates[i] : IT[l.it].cost,
    }));
    const id = "PO-2026-0" + (s.seq.po + 1);
    set({
      seq: { ...s.seq, po: s.seq.po + 1 }, drawer: null,
      po: [{ id, prq: prqId, vendor, at: now(), lines, st: "Ordered", eta }, ...s.po],
      prq: s.prq.map((x) => x.id === prqId ? { ...x, st: "Ordered" as const } : x),
    });
    get().notify(`${id} raised on ${vendor} — expected ${eta}`);
  },
  declineRequisition: (prqId) => {
    set((s) => ({ prq: s.prq.map((x) => x.id === prqId ? { ...x, st: "Declined" as const } : x), drawer: null }));
    get().notify(`${prqId} declined`);
  },
  receiveRequisition: (prqId) => {
    const s = get();
    const p = s.prq.find((x) => x.id === prqId);
    if (!p || p.st !== "Ordered") return;
    const stock = clone(s.stock);
    p.lines.forEach((l) => {
      stock.store[l.it] = Math.round(((stock.store[l.it] ?? 0) + l.qty) * 1000) / 1000;
    });
    set({
      stock,
      prq: s.prq.map((x) => x.id === prqId ? { ...x, st: "Received" as const } : x),
      po: s.po.map((x) => x.prq === prqId ? { ...x, st: "Received" as const, recv: now() } : x),
    });
    get().notify(`Goods received into ${LOC.store.n} — ${p.lines.length} line${p.lines.length > 1 ? "s" : ""}`);
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
    const short = o.lines.find((l) => (s.stock.kitchen[l.it] ?? 0) < l.qty);
    if (short) { get().notify(`Kitchen is short of ${IT[short.it].n}`); return; }
    const stock = clone(s.stock);
    o.lines.forEach((l) => {
      stock.kitchen[l.it] = Math.round(((stock.kitchen[l.it] ?? 0) - l.qty) * 1000) / 1000;
    });
    const tid = "TKT-0" + (s.seq.tkt + 1);
    set({
      stock, seq: { ...s.seq, tkt: s.seq.tkt + 1 }, drawer: null,
      tkt: [...s.tkt, { id: tid, req: id, from: "kitchen", to: o.from, lines: o.lines, st: "Issued" }],
      pord: s.pord.map((x) => x.id === id
        ? { ...x, st: "Dispatched" as const, hist: [...x.hist, hist(s.user?.n ?? "", "Dispatched")] } : x),
    });
    get().notify(`${tid} issued — ${LOC[o.from].n} can collect`);
  },
  makeProduct: (it, n) => {
    const s = get();
    if (!(n > 0)) { get().notify("Enter a quantity to make"); return; }
    if (s.ovr["kitchen:" + it]) { get().notify(`${IT[it].n} is switched off in the kitchen`); return; }
    const stock = clone(s.stock);
    stock.kitchen[it] = (stock.kitchen[it] ?? 0) + n;
    const id = "BAT-20260826-" + String(s.seq.bat + 1).padStart(2, "0");
    const bb = new Date(Date.now() + (IT[it].sl ?? 8) * 3600000)
      .toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
    set({
      stock, seq: { ...s.seq, bat: s.seq.bat + 1 },
      batch: [{ id, it, qty: n, made: n, at: now(), bb }, ...s.batch],
    });
    get().notify(`${id} — ${n} ${IT[it].n} made, best before ${bb}`);
  },
  distribute: (it, n, to) => {
    const s = get();
    if (!(n > 0)) { get().notify("Enter a quantity"); return; }
    if ((s.stock.kitchen[it] ?? 0) < n) { get().notify(`Kitchen holds only ${s.stock.kitchen[it] ?? 0}`); return; }
    const stock = clone(s.stock);
    stock.kitchen[it] = Math.round((stock.kitchen[it] - n) * 1000) / 1000;
    const tid = "TKT-0" + (s.seq.tkt + 1);
    set({
      stock, seq: { ...s.seq, tkt: s.seq.tkt + 1 },
      tkt: [...s.tkt, { id: tid, req: "Direct issue", from: "kitchen", to, lines: [{ it, qty: n }], st: "Issued" }],
    });
    get().notify(`${tid} issued — ${n} ${IT[it].n} to ${LOC[to].n}`);
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
  setShopFilter: (shopFilter) => set({ shopFilter }),
}));
