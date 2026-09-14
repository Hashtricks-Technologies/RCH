import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { AdjustReasonSchema, CreateAdjustmentBodySchema, DeskReplyBodySchema, CreatePoBodySchema, CreditParamsSchema, CreditResponseSchema, EVENTS_PATH, EventNoticeSchema, LocKeySchema, MakeBatchBodySchema, PatchContractBodySchema, PatchPayerBodySchema, PatchPoBodySchema, PatchVendorBodySchema, PO_APPROVAL_LIMIT, RaiseTicketBodySchema, RateTicketBodySchema, ReceivePoBodySchema, SetOrderStatusBodySchema, SetTicketStatusBodySchema, StockLedgerQuerySchema, StockLocSchema, TktStatusSchema, TransferBodySchema, ItemSchema, PatchItemBodySchema } from "./index";
import { routes } from "./routes";

/** One valid body per route that takes one. The coverage case below fails if a new route
 *  arrives without a sample, so "every body schema" stays literally every body schema. */
const SAMPLES: Record<string, Record<string, unknown>> = {
  login: { emp: "RC-4471", password: "changeme" },
  changePassword: { current: "changeme", next: "a-much-longer-secret" },
  patchMe: { n: "Kavitha Raman" },
  pay: { loc: "kitchen", tender: "Cash", lines: [{ it: "SKU-1", qty: 2 }] },
  toggleAvail: { loc: "kitchen", it: "SKU-1" },
  savePrice: { price: 100 },
  addMenuItem: { it: "SKU-1" },
  createRequest: { lines: [{ it: "SKU-1", qty: 20 }], note: "Counter runs dry by 4pm", urgent: true },
  approveRequest: { appr: [12], note: "Store only holds 12 L." },
  rejectRequest: { note: "Kiosk is overstocked already" },
  handover: { otp: "418327" },
  transfer: { from: "coffee", to: "kiosk", it: "SKU-1", qty: 6 },
  askShop: { to: "kiosk", it: "SKU-1", qty: 6, note: "Lunch rush cleared us out" },
  answerShopAsk: { grant: 6 },
  declineShopAsk: { reason: "We are short ourselves" },
  distribute: { it: "SKU-1", qty: 5, to: "kiosk" },
  setOrderStatus: { st: "Accepted" },
  makeBatch: { it: "SKU-1", started: 60, made: 58, note: "Oven tray dropped" },
  cancelTicket: { reason: "The counter closed before the collector came" },
  createRequisition:    { lines: [{ it: "milk", qty: 60 }], note: "Milk at zero in the coffee shop" },
  approveRequisition:   { appr: [60, 6], note: "Approved in full." },
  declineRequisition:   { note: "Last lot is still moving." },
  addToProcurementList: { lines: [{ it: "cup", qty: 500 }], note: "Festival week — the store keeper is on leave" },
  createPo:             { vendorId: "VN-001", picks: [{ prq: "PRQ-2026-013", line: 0, qty: 60 }] },
  updatePoLine:         { qty: 40 },
  patchPo:              { eta: "2026-09-11" },
  cancelPo:             { reason: "Vendor cannot supply this week" },
  receivePo:            { dc: "DC-88214", invoice: "INV/AAV/4472", invDate: "2026-09-04",
                          lines: [{ recv: 60, rejected: 0, batch: "AAV-8893", mrp: 0, mfg: "2026-09-01", exp: "2026-09-08" }] },
  closePoShort:         { reason: "Vendor cannot deliver the balance" },
  addVendor:            { n: "Kumaran Traders", gstin: "33AAACA1234F1Z5", contact: "Kumar S", ph: "98430 11220", terms: "30 days", lead: 2, groups: ["Grocery"] },
  updateVendor:         { active: false },
  addContract:          { vendorId: "VN-001", it: "milk", rate: 52, from: "2026-04-01", to: "2027-03-31", moq: 40 },
  updateContract:       { rate: 54 },
  createItem:           { name: "Cold coffee premix 1kg", unit: "kg", type: "RAW", cost: 320, loc: "store", opening: 0 },
  createProductRequest: { name: "Sugar-free lemon iced tea 250ml", why: "Diabetic attenders ask daily", forLoc: "coffee" },
  answerProductRequest: { st: "Declined", note: "Vendor cannot supply reliably" },
  raiseTicket:     { topic: "A number looks wrong", subject: "Cash collected shows zero all morning",
                     body: "Sales is climbing but cash collected has not moved since I opened.",
                     priority: "Urgent", screen: "Dashboard" },
  replyToTicket:   { body: "Refreshed and it reads correctly now — thank you." },
  setTicketStatus: { st: "Resolved" },
  rateTicket:      { rating: 5 },
  // ---- the admin's support desk
  replyAsDesk:         { body: "Fixed on our side — reload the dashboard and it should read right.", st: "Resolved" },
  setDeskTicketStatus: { st: "Waiting on you" },
  // ---- payers ----
  addPayer:        { kind: "staff", id: "E2291", name: "Kavitha Raman" },
  updatePayer:     { active: false },
  // ---- item patch ----
  patchItem:       { rl: 12 },
  // ---- bill void
  voidBill: { reason: "Wrong tender — customer paid cash" },
  // ---- adjustments
  createAdjustment: { loc: "store", reason: "wastage", note: "Dropped tray", lines: [{ it: "milk", qty: -2 }] },
  // ---- prod-order raise ----
  createProdOrder: { lines: [{ it: "puff", qty: 40 }], need: "2026-09-11", note: "Lunch rush" },
  // ---- admin: account management (a capability, not a role — root CLAUDE.md)
  createAdminUser: { name: "Anitha R", email: "anitha.r@royalcare.in", role: "counter", loc: "rest" },
  updateAdminUser: { role: "counter", loc: "kiosk" },
  // ---- recipes
  saveRecipe: { ov: 12, lines: [{ it: "milk", qty: 0.15 }, { it: "cup", qty: 1 }] },
};
// `routes` is a const object, so `r.body` is a union of every literal schema type; the cast
// keeps this loop about the shared `safeParse` and not about zod's generics.
const withBody: Array<[string, z.ZodTypeAny]> = Object.entries(routes)
  .filter(([, r]) => r.body !== undefined)
  .map(([name, r]) => [name, r.body as z.ZodTypeAny]);

describe("request bodies", () => {
  it("every route that takes a body has a sample here", () => {
    expect(withBody.map(([n]) => n).sort()).toEqual(Object.keys(SAMPLES).sort());
  });
  for (const [name, body] of withBody) {
    it(`${name} accepts its own shape and refuses an unknown key`, () => {
      expect(body.safeParse(SAMPLES[name]).success).toBe(true);
      const bad = body.safeParse({ ...SAMPLES[name], surprise: 1 });
      expect(bad.success, `${name} silently dropped an unknown key`).toBe(false);
    });
  }
});

describe("the event stream", () => {
  it("is not a manifest route — it is a stream, not a JSON endpoint", () => {
    expect(Object.values(routes).some((r) => r.path === EVENTS_PATH)).toBe(false);
  });
  it("names one collection at a time, from the same enum `changed` draws on", () => {
    expect(EventNoticeSchema.safeParse({ collection: "req", at: "2026-09-04T04:30:00.000Z" }).success).toBe(true);
    expect(EventNoticeSchema.safeParse({ collection: "nonsense", at: "2026-09-04T04:30:00.000Z" }).success).toBe(false);
    expect(EventNoticeSchema.safeParse({ collection: "req", at: "…", extra: 1 }).success).toBe(false);
  });
});

describe("the kitchen's writes and a ticket taken back", () => {
  it("takes a make with no yield and no reason — the blank boxes mean 'all of them, nothing to explain'", () => {
    expect(MakeBatchBodySchema.safeParse({ it: "puff", started: 10 }).success).toBe(true);
  });
  it("refuses a status the board does not have", () => {
    expect(SetOrderStatusBodySchema.safeParse({ st: "Baked" }).success).toBe(false);
  });
  it("knows a ticket can end without ever being collected", () => {
    expect(TktStatusSchema.safeParse("Cancelled").success).toBe(true);
  });
});

describe("what buying puts on the wire", () => {
  it("takes a receipt line with a rejection, and refuses one whose date is not ISO-shaped", () => {
    const line = { recv: 60, rejected: 12, batch: "AAV-8893", mrp: 20, mfg: "2026-09-01", exp: "2026-09-08" };
    expect(ReceivePoBodySchema.safeParse({ dc: "DC-1", invoice: "", invDate: "", lines: [line] }).success).toBe(true);
    expect(ReceivePoBodySchema.safeParse({ dc: "DC-1", invoice: "", invDate: "", lines: [{ ...line, exp: "08-09-2026" }] }).success).toBe(false);
  });
  it("leaves a zero quantity to the service, so the operator reads a sentence and not a 400", () => {
    expect(CreatePoBodySchema.safeParse({ vendorId: "VN-001", picks: [{ prq: "PRQ-2026-013", line: 0, qty: 0 }] }).success).toBe(true);
  });
  it("takes a patch that names only one field, and adds nothing to an empty one", () => {
    expect(PatchPoBodySchema.safeParse({ vendorId: "VN-002" }).success).toBe(true);
    expect(PatchPoBodySchema.parse({})).toEqual({});               // refused in the service, with a sentence
    expect(PatchVendorBodySchema.safeParse({ active: true }).success).toBe(true);
    // No patch schema may carry a default: `.parse({})` must stay empty, or "Nothing to change"
    // is unreachable and a patch of one field silently resets every other one.
    expect(PatchVendorBodySchema.parse({})).toEqual({});
    expect(PatchContractBodySchema.parse({})).toEqual({});
    expect(PatchPayerBodySchema.parse({})).toEqual({});
    // ---- item patch ----
    expect(PatchItemBodySchema.parse({})).toEqual({});
    expect(PatchVendorBodySchema.parse({ terms: "45 days" })).toEqual({ terms: "45 days" });
  });
  it("knows quarantine is somewhere stock can be, and nowhere an operator can act", () => {
    expect(StockLocSchema.safeParse("quarantine").success).toBe(true);
    expect(LocKeySchema.safeParse("quarantine").success).toBe(false);
    expect(TransferBodySchema.safeParse({ from: "rest", to: "quarantine", it: "water", qty: 1 }).success).toBe(false);
  });
  it("carries the finance slab as a rule's constant, not as seed data", () => {
    expect(PO_APPROVAL_LIMIT).toBe(25000);
  });
});

describe("what the two reports put on the wire", () => {
  it("answers a bare stock-ledger URL, because the manifest's own probe sends one", () => {
    // `apps/api/src/contract.test.ts` probes every param-less GET with no query string at all.
    // A required `loc` would make that probe a 400, so `loc` carries the report's home screen
    // as its default and `days` the month the store keeper reads.
    expect(StockLedgerQuerySchema.parse({})).toEqual({ loc: "store", days: 30 });
  });
  it("takes the window as a number the URL spelled as a string, inside one year", () => {
    expect(StockLedgerQuerySchema.parse({ loc: "quarantine", days: "7" })).toEqual({ loc: "quarantine", days: 7 });
    expect(StockLedgerQuerySchema.safeParse({ days: 0 }).success).toBe(false);
    expect(StockLedgerQuerySchema.safeParse({ days: 366 }).success).toBe(false);
    expect(StockLedgerQuerySchema.safeParse({ days: 1.5 }).success).toBe(false);
  });
  it("reports a StockLoc, so quarantine has a ledger and a canteen does not", () => {
    // The rejected-goods shelf is the only view anyone has of what a goods receipt turned away,
    // and this is a report, not a write body — `StockLocSchema`, never `LocKeySchema`.
    expect(StockLedgerQuerySchema.safeParse({ loc: "quarantine" }).success).toBe(true);
    expect(StockLedgerQuerySchema.safeParse({ loc: "canteen" }).success).toBe(false);
    expect(StockLedgerQuerySchema.safeParse({ loc: "store", surprise: 1 }).success).toBe(false);
  });
  it("names a payer by a kind the roster has and an id that is not blank", () => {
    expect(CreditParamsSchema.safeParse({ kind: "staff", id: "RC-4471" }).success).toBe(true);
    expect(CreditParamsSchema.safeParse({ kind: "supplier", id: "RC-4471" }).success).toBe(false);
    expect(CreditParamsSchema.safeParse({ kind: "staff", id: "" }).success).toBe(false);
  });
  it("carries the window it settled the ceiling over, not just the number", () => {
    const body = { kind: "staff", id: "RC-4471", name: "Kavitha Raman · F&B", since: "2026-09-01T00:00:00.000Z", taken: 240, limit: 3000, room: 2760 };
    expect(CreditResponseSchema.safeParse(body).success).toBe(true);
    const { since: _since, ...withoutSince } = body;
    expect(CreditResponseSchema.safeParse(withoutSince).success).toBe(false);
  });
});

describe("what the support desk puts on the wire", () => {
  it("takes a ticket with an empty body — the first message is optional, the subject is not", () => {
    const base = { topic: "Something else", subject: "s", priority: "Low", screen: "Dashboard" } as const;
    expect(RaiseTicketBodySchema.safeParse({ ...base, body: "" }).success).toBe(true);
    // An empty subject is a service rule, not a schema rule: the operator reads the store's own
    // sentence ("Give the ticket a subject so support knows what it is about"), not a 400.
    expect(RaiseTicketBodySchema.safeParse({ ...base, subject: "", body: "" }).success).toBe(true);
    expect(RaiseTicketBodySchema.safeParse({ ...base, body: "", topic: "Kitchen fire" }).success).toBe(false);
  });

  it("takes only the five words a ticket can be in, and only the five ratings", () => {
    expect(SetTicketStatusBodySchema.safeParse({ st: "Closed" }).success).toBe(true);
    // "Waiting on you" is a real status but never one a user may set; the service refuses it
    // with a sentence, so the schema still accepts it. What the schema refuses is a non-status.
    expect(SetTicketStatusBodySchema.safeParse({ st: "Waiting on you" }).success).toBe(true);
    expect(SetTicketStatusBodySchema.safeParse({ st: "Done" }).success).toBe(false);
    expect(RateTicketBodySchema.safeParse({ rating: 3 }).success).toBe(true);
    expect(RateTicketBodySchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(RateTicketBodySchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(RateTicketBodySchema.safeParse({ rating: 4.5 }).success).toBe(false);
  });

  it("lets the desk send a reply alone, or with one of the two words its buttons send it with", () => {
    expect(DeskReplyBodySchema.safeParse({ body: "Looking at it now." }).success).toBe(true);
    expect(DeskReplyBodySchema.safeParse({ body: "Can you send the bill number?", st: "Waiting on you" }).success).toBe(true);
    // Closing and picking up are status moves of their own, never what a reply is sent with.
    expect(DeskReplyBodySchema.safeParse({ body: "x", st: "Closed" }).success).toBe(false);
    expect(DeskReplyBodySchema.safeParse({ body: "x", st: "Open" }).success).toBe(false);
  });

  it("puts the desk behind the admin flag, and every user's own doors in front of every role", () => {
    for (const k of ["deskTickets", "replyAsDesk", "setDeskTicketStatus"] as const) expect(routes[k].access).toBe("admin");
    for (const k of ["tickets", "raiseTicket", "replyToTicket", "setTicketStatus", "rateTicket"] as const) expect(routes[k].access).toBe("any");
  });
});

// ---- item patch ----
describe("what the item master puts on the wire once it can be edited", () => {
  it("takes a patch of one field and leaves the other eight alone", () => {
    expect(PatchItemBodySchema.parse({ rl: 12 })).toEqual({ rl: 12 });
    expect(PatchItemBodySchema.safeParse({ active: false }).success).toBe(true);
    expect(PatchItemBodySchema.safeParse({ n: "Real Juice 200ml", mrp: 22, gst: 12 }).success).toBe(true);
    expect(PatchItemBodySchema.safeParse({ surprise: 1 }).success).toBe(false);
  });

  it("carries a shelf life the same way create-item does — an optional whole number of hours", () => {
    expect(PatchItemBodySchema.parse({ sl: 6 })).toEqual({ sl: 6 });
    expect(PatchItemBodySchema.safeParse({ sl: 0 }).success).toBe(true);
    expect(PatchItemBodySchema.safeParse({ sl: 1.5 }).success).toBe(false);
    expect(PatchItemBodySchema.safeParse({ sl: -1 }).success).toBe(false);
  });

  it("leaves an empty name and a zero cost to the service, so the operator reads a sentence", () => {
    // "Give the product a name" and "Cost must be more than zero" are `createItem`'s own
    // sentences; a patch that reached them as a 400 would answer with a Zod path instead.
    expect(PatchItemBodySchema.safeParse({ n: "" }).success).toBe(true);
    expect(PatchItemBodySchema.safeParse({ cost: 0 }).success).toBe(true);
    // What the schema does refuse is a figure no rate anywhere in the system can be.
    expect(PatchItemBodySchema.safeParse({ cost: -1 }).success).toBe(false);
    expect(PatchItemBodySchema.safeParse({ gst: 101 }).success).toBe(false);
  });

  it("carries a retired line on the wire, and an old one with no flag at all", () => {
    const item = { c: "MR-3001", n: "Real Juice 200ml", u: "nos", t: "MRP", g: "Beverage", hsn: "2009", gst: 12, rl: 60, cost: 14.2 };
    expect(ItemSchema.safeParse({ ...item, active: false }).success).toBe(true);
    // Absent means active: every fixture and every document raised before retiring existed.
    expect(ItemSchema.parse(item).active).toBeUndefined();
  });
});

// ---- adjustments
describe("what an adjustment puts on the wire", () => {
  it("takes a negative quantity, which is the whole point of a write-off", () => {
    const body = { loc: "store", reason: "breakage", lines: [{ it: "milk", qty: -2.5 }] };
    expect(CreateAdjustmentBodySchema.safeParse(body).success).toBe(true);
    expect(CreateAdjustmentBodySchema.parse(body).note).toBe("");
  });
  it("names a StockLoc, because the rejected-goods shelf has to be correctable too", () => {
    // The one write body in the manifest that is not `LocKeySchema`. A consignment turned away
    // at the door sits on that shelf until somebody destroys it or sends it back, and nothing
    // else in the system can take it off again.
    expect(CreateAdjustmentBodySchema.safeParse({ loc: "quarantine", reason: "returned_to_vendor", lines: [{ it: "milk", qty: -2 }] }).success).toBe(true);
    expect(CreateAdjustmentBodySchema.safeParse({ loc: "canteen", reason: "other", lines: [{ it: "milk", qty: -2 }] }).success).toBe(false);
  });
  it("leaves a zero line to the service, so the operator reads a sentence and not a 400", () => {
    expect(CreateAdjustmentBodySchema.safeParse({ loc: "store", reason: "count", lines: [{ it: "milk", qty: 0 }] }).success).toBe(true);
    // Three decimals is the whole precision of a quantity, in both directions.
    expect(CreateAdjustmentBodySchema.safeParse({ loc: "store", reason: "count", lines: [{ it: "milk", qty: -2.0001 }] }).success).toBe(false);
  });
  it("takes only the six reasons a month-end query can group by", () => {
    expect(AdjustReasonSchema.safeParse("expired").success).toBe(true);
    expect(AdjustReasonSchema.safeParse("spoilt").success).toBe(false);
  });
  it("caps the note at what a note is, the way every other free-text field is capped", () => {
    const withNote = (note: string) => ({ loc: "store", reason: "other", note, lines: [{ it: "milk", qty: -1 }] });
    expect(CreateAdjustmentBodySchema.safeParse(withNote("x".repeat(500))).success).toBe(true);
    expect(CreateAdjustmentBodySchema.safeParse(withNote("x".repeat(501))).success).toBe(false);
  });
});
