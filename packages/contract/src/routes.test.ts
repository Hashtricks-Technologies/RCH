import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { EVENTS_PATH, EventNoticeSchema } from "./index";
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
