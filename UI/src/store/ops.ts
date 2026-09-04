import { routes } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import { IT, LOC } from "../data/master";
import { seedContracts, seedProductRequests, seedShopAsks, seedTickets } from "../data/ops";
import type {
  Item, ItemType, LocKey, ProductRequest, RateContract, ShopAsk,
  SupportTicket, TicketPriority, TicketStatus, TicketTopic,
} from "../types";
import { fq, now, U } from "../lib/fmt";
import type { AppState } from "./index";

type Set_ = (p: Partial<AppState>) => void;
type Get = () => AppState;

export interface NewItemInput {
  key: string; name: string; code: string; unit: string; type: ItemType;
  group: string; hsn: string; gst: number; reorder: number; cost: number;
  mrp?: number; shelfLife?: number;
}

export interface OpsSlice {
  tickets: SupportTicket[];
  productReqs: ProductRequest[];
  contracts: RateContract[];
  /** Bumped whenever the catalogue gains an item, so lists re-read it. */
  catalogVersion: number;

  /** Customer care for the portal — a screen misbehaving, a number that looks wrong. */
  raiseTicket: (p: { topic: TicketTopic; subject: string; body: string; priority: TicketPriority; screen: string }) => void;
  replyToTicket: (id: string, body: string) => void;
  setTicketStatus: (id: string, st: TicketStatus) => void;
  rateTicket: (id: string, rating: 1 | 2 | 3 | 4 | 5) => void;

  /** A shop asking the central store to put a brand-new product on the master. */
  requestNewProduct: (p: { name: string; why: string; forLoc: LocKey }) => void;
  answerProductRequest: (id: string, st: "Created" | "Declined", note: string, itemKey?: string) => void;

  addContract: (c: Omit<RateContract, "id">) => void;
  updateContract: (id: string, patch: Partial<Omit<RateContract, "id">>) => void;
  removeContract: (id: string) => void;
  contractRate: (vendor: string, it: string) => RateContract | undefined;

  createItem: (input: NewItemInput, loc: LocKey, opening: number) => void;
  /** Shop to shop, no manager in the middle. */
  transferToOutlet: (from: LocKey, to: LocKey, it: string, qty: number) => Promise<void>;

  shopAsks: ShopAsk[];
  /** Counter at `from` asks the shop at `to` for stock it is holding. */
  askShop: (to: LocKey, it: string, qty: number, note: string) => Promise<void>;
  /** The holding shop grants some or all of it, which issues the transfer ticket. */
  answerShopAsk: (id: string, grant: number) => Promise<void>;
  declineShopAsk: (id: string, reason: string) => Promise<void>;
}

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "item";

export const createOpsSlice = (set: Set_, get: Get): OpsSlice => ({
  tickets: seedTickets(),
  productReqs: seedProductRequests(),
  contracts: seedContracts(),
  catalogVersion: 0,
  shopAsks: seedShopAsks(),

  raiseTicket: ({ topic, subject, body, priority, screen }) => {
    const s = get();
    if (!s.user) return;
    if (!subject.trim()) { s.notify("Give the ticket a subject so support knows what it is about"); return; }
    const id = "SUP-00" + (s.tickets.length + 41);
    set({
      tickets: [{
        id, topic, subject: subject.trim(), priority, st: "Open",
        by: s.user.n, role: s.user.r, loc: s.user.loc, at: now(), screen,
        messages: body.trim()
          ? [{ id: "m1", from: "user", who: s.user.n, at: now(), body: body.trim() }]
          : [],
      }, ...s.tickets],
    });
    s.notify(`${id} raised — support replies to urgent tickets within the hour`);
  },
  replyToTicket: (id, body) => {
    const s = get();
    if (!s.user || !body.trim()) { s.notify("Write a reply first"); return; }
    set({
      tickets: s.tickets.map((t) => t.id === id ? {
        ...t,
        st: (t.st === "Waiting on you" || t.st === "Resolved" ? "With support" : t.st) as TicketStatus,
        messages: [...t.messages, {
          id: "m" + (t.messages.length + 1), from: "user" as const,
          who: s.user!.n, at: now(), body: body.trim(),
        }],
      } : t),
    });
    s.notify(`Reply sent on ${id}`);
  },
  setTicketStatus: (id, st) => {
    const s = get();
    set({ tickets: s.tickets.map((t) => (t.id === id ? { ...t, st } : t)) });
    s.notify(`${id} — ${st.toLowerCase()}`);
  },
  rateTicket: (id, rating) => {
    const s = get();
    set({ tickets: s.tickets.map((t) => (t.id === id ? { ...t, rating } : t)) });
    s.notify(`Thank you — ${rating} out of 5 recorded against ${id}`);
  },

  requestNewProduct: ({ name, why, forLoc }) => {
    const s = get();
    if (!s.user) return;
    if (!name.trim()) { s.notify("Name the product you want added"); return; }
    const id = "NPR-00" + (s.productReqs.length + 12);
    set({
      productReqs: [{
        id, name: name.trim(), why: why.trim(), forLoc,
        by: s.user.n, at: now(), st: "Requested",
      }, ...s.productReqs],
    });
    s.notify(`${id} sent to the central store — they add it to the master`);
  },
  answerProductRequest: (id, st, note, itemKey) => {
    const s = get();
    set({
      productReqs: s.productReqs.map((p) =>
        p.id === id ? { ...p, st, note: note.trim(), itemKey } : p),
    });
    s.notify(st === "Created" ? `${id} — product created on the master` : `${id} declined`);
  },

  addContract: (c) => {
    const s = get();
    if (s.contracts.some((x) => x.vendor === c.vendor && x.it === c.it && x.active)) {
      s.notify(`${IT[c.it]?.n ?? c.it} already has a live contract with ${c.vendor}`);
      return;
    }
    const id = "RC-" + String(s.contracts.length + 101);
    set({ contracts: [{ ...c, id }, ...s.contracts] });
    s.notify(`${id} — ${IT[c.it]?.n ?? c.it} at ₹${c.rate} with ${c.vendor}`);
  },
  updateContract: (id, patch) => {
    const s = get();
    set({ contracts: s.contracts.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
    s.notify(`${id} updated`);
  },
  removeContract: (id) => {
    const s = get();
    set({ contracts: s.contracts.map((c) => (c.id === id ? { ...c, active: false } : c)) });
    s.notify(`${id} closed — it stays on record but no longer prices an order`);
  },
  contractRate: (vendor, it) =>
    get().contracts.find((c) => c.active && c.vendor === vendor && c.it === it),

  createItem: (input, loc, opening) => {
    const s = get();
    const name = input.name.trim();
    if (!name) { s.notify("Give the product a name"); return; }
    let key = input.key.trim() || slug(name);
    if (IT[key]) {
      let n = 2;
      while (IT[`${key}${n}`]) n += 1;
      key = `${key}${n}`;
    }
    if (Object.values(IT).some((i) => i.n.toLowerCase() === name.toLowerCase())) {
      s.notify(`${name} is already in the catalogue`);
      return;
    }
    const item: Item = {
      c: input.code.trim() || key.toUpperCase(),
      n: name,
      u: input.unit || "nos",
      t: input.type,
      g: input.group || "Other",
      hsn: input.hsn || "2106",
      gst: Number.isFinite(input.gst) ? input.gst : 5,
      rl: Number.isFinite(input.reorder) ? input.reorder : 0,
      cost: Number.isFinite(input.cost) ? input.cost : 0,
      ...(input.mrp ? { mrp: input.mrp } : {}),
      ...(input.shelfLife ? { sl: input.shelfLife } : {}),
    };
    // The catalogue is a module-level record every screen reads directly, so it is
    // mutated in place; catalogVersion is what tells React the lists changed.
    IT[key] = item;
    const stock = JSON.parse(JSON.stringify(s.stock)) as AppState["stock"];
    if (opening > 0) stock[loc][key] = opening;
    set({ stock, catalogVersion: s.catalogVersion + 1 });
    s.notify(
      opening > 0
        ? `${name} added to the catalogue with ${fq(opening, key)} ${U(key)} at ${LOC[loc].n}`
        : `${name} added to the catalogue`
    );
  },

  /**
   * Shop to shop is the server's from Phase 3. Each of the four posts its body, repeats the
   * sentence that came back and refetches what the write named — the cover check, the
   * outlet-to-outlet rule and the ticket's number are all decided there, not here.
   */
  transferToOutlet: async (from, to, it, qty) => {
    try {
      const r = await call(routes.transfer, { body: { from, to, it, qty } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not send the transfer — check the connection and try again.");
    }
  },

  askShop: async (to, it, qty, note) => {
    try {
      const r = await call(routes.askShop, { body: { to, it, qty, note: note.trim() } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not send the ask — check the connection and try again.");
    }
  },

  /** One endpoint grants the ask *and* raises the ticket; calling the transfer too would
   *  raise a second one for the same stock. */
  answerShopAsk: async (id, grant) => {
    try {
      const r = await call(routes.answerShopAsk, { params: { id }, body: { grant } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not answer the ask — check the connection and try again.");
    }
  },

  declineShopAsk: async (id, reason) => {
    try {
      const r = await call(routes.declineShopAsk, { params: { id }, body: { reason: reason.trim() } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not decline the ask — check the connection and try again.");
    }
  },
});
