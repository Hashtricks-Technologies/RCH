import { routes } from "@rch/contract";
import { contractInWindow, istDate } from "@rch/domain";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import type {
  ItemType, LocKey, ProductRequest, RateContract, ShopAsk,
  SupportTicket, TicketPriority, TicketStatus, TicketTopic,
} from "../types";
import { toInputDate } from "../lib/fmt";
import type { AppState } from "./index";

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

  /** Customer care for the portal — a screen misbehaving, a number that looks wrong. The two
   *  that carry a form answer `true` only once the server has taken them, so a refusal lands on
   *  what the operator typed; the two that are a single press answer nothing but a toast. */
  raiseTicket: (p: { topic: TicketTopic; subject: string; body: string; priority: TicketPriority; screen: string }) => Promise<boolean>;
  replyToTicket: (id: string, body: string) => Promise<boolean>;
  setTicketStatus: (id: string, st: TicketStatus) => Promise<void>;
  rateTicket: (id: string, rating: 1 | 2 | 3 | 4 | 5) => Promise<void>;

  /** A shop asking the central store to put a brand-new product on the master. */
  requestNewProduct: (p: { name: string; why: string; forLoc: LocKey }) => Promise<boolean>;
  answerProductRequest: (id: string, st: "Created" | "Declined", note: string, itemKey?: string) => Promise<boolean>;

  /** Exactly what `ContractBodySchema` takes, and nothing else. The vendor travels as an **id**
   *  — "vendor and item exist" is a question only an id can answer — while the register on
   *  screen goes on printing the name the contract carries back. */
  addContract: (c: { vendorId: string; it: string; rate: number; from: string; to: string; moq: number }) => Promise<boolean>;
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

/** Every action in this slice is the server's now: post the body, repeat the sentence that came
 *  back, refetch what the write named. Nothing here decides anything — the support desk's
 *  status words come from `@rch/domain`'s table and its refusals are the server's own. */
const fail = (get: Get, e: unknown, what: string): false => {
  get().notify(e instanceof ApiError ? e.message : `Could not ${what} — check the connection and try again.`);
  return false;
};

export const createOpsSlice = (get: Get): OpsSlice => ({
  tickets: [],
  productReqs: [],
  contracts: [],
  catalogVersion: 0,
  shopAsks: [],

  /**
   * The support desk (POST /support/tickets and its three `:id` doors). The subject rule, the
   * status a reply lands the ticket on, which words a person may set and when a rating is
   * taken are all the server's, read from `@rch/domain`'s `support.ts` — nothing is decided
   * here and no sentence is written here. Every one of the four names `changed: ["tickets"]`,
   * which has its own narrow reader, so a reply costs one GET rather than a whole snapshot.
   */
  raiseTicket: async (p) => {
    try {
      // The body carries what was typed: trimming is the server's, and its refusal has to land
      // on the operator's own words rather than on something the browser tidied first.
      const r = await call(routes.raiseTicket, { body: p });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "raise the ticket"); }
  },
  replyToTicket: async (id, body) => {
    try {
      const r = await call(routes.replyToTicket, { params: { id }, body: { body } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "send the reply"); }
  },
  setTicketStatus: async (id, st) => {
    try {
      const r = await call(routes.setTicketStatus, { params: { id }, body: { st } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) { fail(get, e, "change the ticket"); }
  },
  rateTicket: async (id, rating) => {
    try {
      const r = await call(routes.rateTicket, { params: { id }, body: { rating } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
    } catch (e) { fail(get, e, "record the rating"); }
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
  // The same window test the server prices an order with (`purchaseOrdersRepo.activeContractRates`):
  // `from`/`to` here are DD-MMM-YYYY display strings, so they go through `toInputDate` before
  // `contractInWindow` compares them as ISO dates against today's, in the hospital's calendar —
  // a lapsed-but-still-`active` contract must not preview a rate the order will not get.
  contractRate: (vendor, it) => {
    const today = istDate(new Date());
    return get().contracts.find((c) =>
      c.active && c.vendor === vendor && c.it === it &&
      contractInWindow({ from: toInputDate(c.from), to: toInputDate(c.to) }, today));
  },

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
