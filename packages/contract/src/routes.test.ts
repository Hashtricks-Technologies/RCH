import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { CreatePoBodySchema, EVENTS_PATH, EventNoticeSchema, LocKeySchema, MakeBatchBodySchema, PatchContractBodySchema, PatchPoBodySchema, PatchVendorBodySchema, PO_APPROVAL_LIMIT, ReceivePoBodySchema, SetOrderStatusBodySchema, StockLocSchema, TktStatusSchema, TransferBodySchema } from "./index";
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
  it("takes a receipt line with a rejection, and refuses a rejection larger than the schema's own bound", () => {
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
