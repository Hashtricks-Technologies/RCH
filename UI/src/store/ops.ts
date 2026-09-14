import { routes } from "@rch/contract";
import { contractInWindow, istDate } from "@rch/domain";
import { ApiError, call } from "../api/client";
import { refetch } from "../api/refetch";
import { applyDeskTickets, applyPayers } from "../api/wire";
import type {
  AdjustReason, Dated, ItemType, LocKey, PayerKind, PayerRecord, ProductRequest, RateContract,
  ShopAsk, StockLoc, SupportTicket, TicketPriority, TicketStatus, TicketTopic,
} from "../types";
import { toInputDate } from "../lib/fmt";
import type { AppState } from "./index";

type Get = () => AppState;

export interface NewItemInput {
  key: string; name: string; code: string; unit: string; type: ItemType;
  group: string; hsn: string; gst: number; reorder: number; cost: number;
  mrp?: number; shelfLife?: number;
}

// ---- item patch ----
/** Exactly what `PatchItemBodySchema` takes: every field optional, nothing defaulted. A field
 *  left out is a field left alone — sending it as `undefined` would be the same thing, but the
 *  drawer only ever puts in what the operator actually moved. */
export interface ItemFieldPatch {
  n?: string; mrp?: number; cost?: number; gst?: number;
  hsn?: string; rl?: number; grp?: string; sl?: number; active?: boolean;
}

export interface OpsSlice {
  /** Dated like every other document the store holds: the "HH:MM" on screen, plus the instant
   *  it was made from, so "today" and "newest first" are answerable (`Dated` in `types.ts`). */
  tickets: Dated<SupportTicket>[];
  productReqs: Dated<ProductRequest>[];
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

  /** The desk: every ticket, whoever raised it, read by the admin-flagged account on `/admin`.
   *  Kept apart from `tickets` (the caller's own) so neither list is ever mistaken for the other. */
  deskTickets: Dated<SupportTicket>[];
  /** A first load, not a write's read-back: no toast on success, nothing refetched behind it. */
  loadDeskTickets: () => Promise<void>;
  /** Form-carrying: `true` only once the server has taken the reply, so a refusal keeps the words.
   *  `st` is the status the reply is sent with (Send & ask user, Send & resolve). */
  replyAsDesk: (id: string, body: string, st?: "Waiting on you" | "Resolved") => Promise<boolean>;
  setDeskTicketStatus: (id: string, st: TicketStatus) => Promise<boolean>;

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
  // ---- item patch ----
  /** An existing line on the master, edited or retired. Which of the eight fields the caller's
   *  own role may move is `ITEM_FIELD_ROLES` (`@rch/domain`) — the drawer disables the boxes it
   *  answers `false` for and the server refuses them in the operator's own words, so the same
   *  table drives the form and the refusal. */
  updateItem: (it: string, patch: ItemFieldPatch) => Promise<boolean>;
  /** Shop to shop, no manager in the middle. Answers `true` only once the server took it, so
   *  a screen can hold on to what the operator typed when it is refused. */
  transferToOutlet: (from: LocKey, to: LocKey, it: string, qty: number) => Promise<boolean>;

  shopAsks: Dated<ShopAsk>[];
  /** Counter at `from` asks the shop at `to` for stock it is holding. */
  askShop: (to: LocKey, it: string, qty: number, note: string) => Promise<boolean>;
  /** The holding shop grants some or all of it, which issues the transfer ticket. */
  answerShopAsk: (id: string, grant: number) => Promise<boolean>;
  declineShopAsk: (id: string, reason: string) => Promise<boolean>;

  // ---- payers ----
  /**
   * The register behind the non-cash tenders, and the one screen that keeps it.
   *
   * Two reads answer for one table, and both writes name both. `roster` is the till's live list
   * and lands in the `PATIENTS`/`STAFF`/`DEPTS` registries (`applyRoster`) — not store state,
   * because the payer picker imports those directly. `payers` is the manager's own register,
   * closed accounts included, and *is* store state: the Roster screen has to draw a switched-off
   * row to offer a way to switch it back on, and the till's read can never carry one.
   */
  payers: PayerRecord[];
  /** Fills `payers` for the screen that renders it. A read, so no toast on success and no
   *  refetch of its own — and `null`-free, because an empty register and a failed read look the
   *  same on this screen: a table with an empty state and a toast beside it. */
  loadPayers: () => Promise<void>;
  /** Both carry a form, so both answer `true` only once the server has taken it and a refusal
   *  leaves what was typed on screen. */
  addPayer: (body: { kind: PayerKind; id: string; name: string }) => Promise<boolean>;
  updatePayer: (kind: PayerKind, id: string, patch: { name?: string; active?: boolean }) => Promise<boolean>;
  // ---- adjustments
  /** A write-off or a count-up, as a document: some lines down, some up, one reason over the
   *  lot. Answers `true` only once the server has taken it, so a refusal leaves the form with
   *  what the operator typed still on it. Every rule — what folds, what is free to write off,
   *  which shelves this role may touch — is the server's; nothing is decided here. */
  createAdjustment: (body: { loc: StockLoc; reason: AdjustReason; note: string; lines: { it: string; qty: number }[] }) => Promise<boolean>;
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
  payers: [],

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

  /**
   * The admin's side of the same desk (`/admin/support/tickets` and its two `:id` doors). Its
   * writes name `tickets` too; `refetch` reads that collection through the desk's own GET when
   * the session is the admin's, and through the caller's own list for everyone else.
   */
  deskTickets: [],
  loadDeskTickets: async () => {
    try { applyDeskTickets(await call(routes.deskTickets)); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read the support tickets — check the connection and try again."); }
  },
  replyAsDesk: async (id, body, st) => {
    try {
      const r = await call(routes.replyAsDesk, { params: { id }, body: st ? { body, st } : { body } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "send the reply"); }
  },
  setDeskTicketStatus: async (id, st) => {
    try {
      const r = await call(routes.setDeskTicketStatus, { params: { id }, body: { st } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "change the ticket"); }
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

  // ---- item patch ----
  /** The same registry, the other way round: `changed` names "items", `refetch`'s narrow reader
   *  replaces its contents in place and bumps `catalogVersion`, and the drawer keeps whatever
   *  was typed when the server refuses. Nothing is decided here — which fields this role owns,
   *  the MRP floor and whether a line is clear enough to retire are all the server's. */
  updateItem: async (it, patch) => {
    try {
      const r = await call(routes.patchItem, { params: { it }, body: patch });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the product"); }
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

  // ---- payers ----
  // Both post the body as typed — trimming, the "already on the roster" rule and the sentence
  // that comes back are the server's — and refetch the two slices they name. Each has its own
  // narrow reader, so a rename costs two GETs rather than a whole snapshot.
  loadPayers: async () => {
    // The same reader `refetch`'s "payers" entry uses, called directly rather than through
    // `refetch`: this is a first load, and `refetch`'s failure sentence ("Saved — but the screen
    // could not be refreshed") is about a write that already landed.
    try { applyPayers(await call(routes.payers)); }
    catch (e) { get().notify(e instanceof ApiError ? e.message : "Could not read the payer register — check the connection and try again."); }
  },
  addPayer: async (body) => {
    try {
      const r = await call(routes.addPayer, { body });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the payer"); }
  },
  updatePayer: async (kind, id, patch) => {
    try {
      const r = await call(routes.updatePayer, { params: { kind, id }, body: { name: patch.name, active: patch.active } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "save the payer"); }
  },
  // ---- adjustments
  createAdjustment: async ({ loc, reason, note, lines }) => {
    try {
      const r = await call(routes.createAdjustment, { body: { loc, reason, note: note.trim(), lines } });
      get().notify(r.message);
      await refetch(r.changed, r.message);
      return true;
    } catch (e) { return fail(get, e, "record the adjustment"); }
  },
});
