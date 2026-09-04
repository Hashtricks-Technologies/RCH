import { routes } from "@rch/contract";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import { seedContracts, seedProductRequests, seedShopAsks, seedTickets } from "../data/ops";
import type {
  ItemType, LocKey, ProductRequest, RateContract, ShopAsk,
  SupportTicket, TicketPriority, TicketStatus, TicketTopic,
} from "../types";
import { now } from "../lib/fmt";
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
  requestNewProduct: (p: { name: string; why: string; forLoc: LocKey }) => Promise<boolean>;
  answerProductRequest: (id: string, st: "Created" | "Declined", note: string, itemKey?: string) => Promise<boolean>;

  /** A rate is agreed with a vendor, and the server only answers for a vendor it can find —
   *  which is an id, never the name the register prints. */
  addContract: (c: Omit<RateContract, "id"> & { vendorId: string }) => Promise<boolean>;
  updateContract: (id: string, patch: { rate?: number; from?: string; to?: string; moq?: number; active?: boolean }) => Promise<boolean>;
  removeContract: (id: string) => Promise<void>;
  contractRate: (vendor: string, it: string) => RateContract | undefined;

  /** The key the server chose, or null — the drawers need it to link a product request. */
  createItem: (input: NewItemInput, loc: LocKey, opening: number) => Promise<string | null>;
  /** Shop to shop, no manager in the middle. Answers `true` only once the server took it, so
   *  a screen can hold on to what the operator typed when it is refused. */
  transferToOutlet: (from: LocKey, to: LocKey, it: string, qty: number) => Promise<boolean>;

  shopAsks: ShopAsk[];
  /** Counter at `from` asks the shop at `to` for stock it is holding. */
  askShop: (to: LocKey, it: string, qty: number, note: string) => Promise<boolean>;
  /** The holding shop grants some or all of it, which issues the transfer ticket. */
  answerShopAsk: (id: string, grant: number) => Promise<boolean>;
  declineShopAsk: (id: string, reason: string) => Promise<boolean>;
}

/** Buying's half of this slice is the server's from Phase 5: post the body, repeat the sentence
 *  that came back, refetch what the write named. The four support actions are Phase 6's and are
 *  still local. */
const fail = (get: Get, e: unknown, what: string): false => {
  get().notify(e instanceof ApiError ? e.message : `Could not ${what} — check the connection and try again.`);
  return false;
};

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

  requestNewProduct: async ({ name, why, forLoc }) => {
    try {
      const r = await call(routes.createProductRequest, { body: { name: name.trim(), why: why.trim(), forLoc } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "send the request"); }
  },
  answerProductRequest: async (id, st, note, itemKey) => {
    try {
      const r = await call(routes.answerProductRequest, { params: { id }, body: { st, note: note.trim(), itemKey } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "answer the request"); }
  },

  addContract: async (c) => {
    try {
      const r = await call(routes.addContract, {
        body: { vendorId: c.vendorId, it: c.it, rate: c.rate, from: c.from, to: c.to, moq: c.moq },
      });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the contract"); }
  },
  updateContract: async (id, patch) => {
    try {
      const r = await call(routes.updateContract, {
        params: { id },
        body: { rate: patch.rate, from: patch.from, to: patch.to, moq: patch.moq, active: patch.active },
      });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the contract"); }
  },
  removeContract: async (id) => {
    try {
      const r = await call(routes.removeContract, { params: { id } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) { fail(get, e, "close the contract"); }
  },
  contractRate: (vendor, it) =>
    get().contracts.find((c) => c.active && c.vendor === vendor && c.it === it),

  /** The catalogue is a module-level registry every screen reads directly, so nothing is
   *  written here: `changed` names "items" and `refetch`'s reader replaces its contents in
   *  place, bumping `catalogVersion` — which is what tells React the lists moved. */
  createItem: async (input, loc, opening) => {
    try {
      const r = await call(routes.createItem, {
        body: {
          key: input.key.trim(), name: input.name.trim(), code: input.code.trim(),
          unit: input.unit, type: input.type, grp: input.group, hsn: input.hsn,
          gst: input.gst, reorder: input.reorder, cost: input.cost,
          mrp: input.mrp, sl: input.shelfLife, loc, opening,
        },
      });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return r.result.key;
    } catch (e) { fail(get, e, "add the product"); return null; }
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
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not send the transfer — check the connection and try again.");
      return false;
    }
  },

  askShop: async (to, it, qty, note) => {
    try {
      const r = await call(routes.askShop, { body: { to, it, qty, note: note.trim() } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not send the ask — check the connection and try again.");
      return false;
    }
  },

  /** One endpoint grants the ask *and* raises the ticket; calling the transfer too would
   *  raise a second one for the same stock. */
  answerShopAsk: async (id, grant) => {
    try {
      const r = await call(routes.answerShopAsk, { params: { id }, body: { grant } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not answer the ask — check the connection and try again.");
      return false;
    }
  },

  declineShopAsk: async (id, reason) => {
    try {
      const r = await call(routes.declineShopAsk, { params: { id }, body: { reason: reason.trim() } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) {
      get().notify(e instanceof ApiError ? e.message : "Could not decline the ask — check the connection and try again.");
      return false;
    }
  },
});
