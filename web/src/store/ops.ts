import { IT, LOC, OUTLETS } from "../data/master";
import { seedContracts, seedProductRequests, seedTickets } from "../data/ops";
import type {
  Item, ItemType, LocKey, ProductRequest, RateContract, ShopAsk,
  SupportTicket, TicketPriority, TicketStatus, TicketTopic,
} from "../types";
import { fq, makeOtp, now, U } from "../lib/fmt";
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
  transferToOutlet: (from: LocKey, to: LocKey, it: string, qty: number) => void;

  shopAsks: ShopAsk[];
  /** Counter at `from` asks the shop at `to` for stock it is holding. */
  askShop: (to: LocKey, it: string, qty: number, note: string) => void;
  /** The holding shop grants some or all of it, which issues the transfer ticket. */
  answerShopAsk: (id: string, grant: number) => void;
  declineShopAsk: (id: string, reason: string) => void;
}

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "item";

export const createOpsSlice = (set: Set_, get: Get): OpsSlice => ({
  tickets: seedTickets(),
  productReqs: seedProductRequests(),
  contracts: seedContracts(),
  catalogVersion: 0,
  shopAsks: [],

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

  transferToOutlet: (from, to, it, qty) => {
    const s = get();
    if (!OUTLETS.includes(from) || !OUTLETS.includes(to) || from === to) {
      s.notify("A shop transfer runs between two different outlets");
      return;
    }
    if (!(qty > 0)) { s.notify("Enter a quantity"); return; }
    const free = (s.stock[from]?.[it] ?? 0) - (s.rsv[`${from}:${it}`] ?? 0);
    if (free < qty) {
      s.notify(`${LOC[from].n} has only ${fq(free, it)} ${U(it)} free to send`);
      return;
    }
    const id = "TKT-0" + (s.seq.tkt + 1);
    set({
      rsv: { ...s.rsv, [`${from}:${it}`]: (s.rsv[`${from}:${it}`] ?? 0) + qty },
      seq: { ...s.seq, tkt: s.seq.tkt + 1 },
      tkt: [...s.tkt, {
        id, req: "Shop transfer", from, to,
        lines: [{ it, qty }], st: "Issued", otp: makeOtp(s.seq.tkt + 1),
      }],
    });
    s.notify(`${id} issued — ${fq(qty, it)} ${U(it)} reserved at ${LOC[from].n} for ${LOC[to].n}`);
  },

  askShop: (to, it, qty, note) => {
    const s = get();
    if (!s.user) return;
    const from = s.user.loc;
    if (from === to) { s.notify("Pick a different shop"); return; }
    if (!OUTLETS.includes(to)) { s.notify("Only another shop can be asked directly"); return; }
    if (!(qty > 0)) { s.notify("Enter a quantity"); return; }
    const id = "ASK-0" + (s.shopAsks.length + 61);
    set({
      shopAsks: [{
        id, from, to, it, qty, st: "Asked", by: s.user.n, at: now(), note: note.trim(),
      }, ...s.shopAsks],
    });
    s.notify(`${id} sent to ${LOC[to].n} — they decide, not the manager`);
  },

  answerShopAsk: (id, grant) => {
    const s = get();
    const a = s.shopAsks.find((x) => x.id === id);
    if (!a || a.st !== "Asked") return;
    const give = Math.max(0, Math.min(grant, a.qty));
    if (give <= 0) { s.notify("Grant a quantity, or decline the ask"); return; }
    const free = (s.stock[a.to]?.[a.it] ?? 0) - (s.rsv[`${a.to}:${a.it}`] ?? 0);
    if (free < give) {
      s.notify(`${LOC[a.to].n} has only ${fq(free, a.it)} ${U(a.it)} free to send`);
      return;
    }
    const ticketId = "TKT-0" + (s.seq.tkt + 1);
    // reserves at the giving shop and raises the ticket the asker collects against
    get().transferToOutlet(a.to, a.from, a.it, give);
    set({
      shopAsks: get().shopAsks.map((x) =>
        x.id === id ? { ...x, st: "Sent" as const, grant: give, ticket: ticketId } : x),
    });
  },

  declineShopAsk: (id, reason) => {
    const s = get();
    if (!reason.trim()) { s.notify("Give a reason — the other shop sees it"); return; }
    set({
      shopAsks: s.shopAsks.map((x) =>
        x.id === id ? { ...x, st: "Declined" as const, reason: reason.trim() } : x),
    });
    s.notify(`${id} declined`);
  },
});
