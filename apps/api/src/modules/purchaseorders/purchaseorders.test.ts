import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dmy, etaFrom } from "@rch/domain";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll, warmPool } from "../../test/db.js";
import { rateContracts } from "../../db/schema/index.js";
import type { InjectOptions } from "fastify";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "purchaseorders" }); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
/** Send and cancel carry no body, so the payload is optional — spread in rather than sent as
 *  `undefined`, which inject would still turn into an empty body. */
const post = async (u: string, url: string, payload?: object) => {
  const opts: InjectOptions = { method: "POST", url: `/api/v1${url}`, headers: await hdr(u) };
  if (payload !== undefined) opts.payload = payload;
  return app.inject(opts);
};
const patch = async (u: string, url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: await hdr(u), payload });
const del = async (u: string, url: string) =>
  app.inject({ method: "DELETE", url: `/api/v1${url}`, headers: await hdr(u) });
/** The two document collections, off `GET /snapshot` — the six standalone reads are Task 4's,
 *  in this same wave, so this suite must not touch them. */
const snap = async (u = "u5") => (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, u) })).json();
const prqs = async () => (await snap()).prq;
const pos = async () => (await snap()).po;
/** The item master, for a standard cost a case must not retype. `GET /items` is Phase 1's,
 *  unlike the six reads this wave adds. */
const getItems = async () => (await app.inject({ method: "GET", url: "/api/v1/items", headers: await authHeaders(app, "u5") })).json();
/** What is still claimable on one requisition line — the procurement list's own arithmetic. */
const pending = async (prq: string, line: number) => {
  const l = (await prqs()).find((p: { id: string }) => p.id === prq).lines[line];
  return Math.round((l.appr - l.ordered) * 1000) / 1000;
};

describe("POST /purchase-orders", () => {
  it("drafts an order, claims the quantity off the list, and prices off the live contract", async () => {
    // RC-101 is Aavin's live milk contract and its seeded rate is 52 — which is also
    // `IT.milk.cost`, so a case left at the seed's numbers would pass on the cost fallback and
    // prove nothing. Move the contract first, so only contract pricing can produce the answer.
    await app.testDb!.db.update(rateContracts).set({ rate: 49.5 }).where(eq(rateContracts.id, "RC-101"));
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const before = await pending(prq, 0);
    const r = await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 60 }] });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ vendor: "VN-001", st: "Draft" });
    expect(b.result.id).toMatch(/^PO-\d{4}-0\d+$/);
    expect(b.result.lines).toEqual([{ it: "milk", qty: 60, rate: 49.5, recv: 0, rejected: 0, src: [{ prq, line: 0, qty: 60 }] }]);
    expect(b.result.hist.at(-1)).toMatchObject({ s: "Draft", who: "Latha Narayanan" });
    expect(b.changed).toEqual(["po", "prq"]);
    expect(b.message).toBe(`${b.result.id} drafted on Aavin Dairy Depot — 1 line(s), review the rates before sending`);
    expect(await pending(prq, 0)).toBe(before - 60);
  });

  it("prices off the item's own cost when the vendor has no contract for it", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "bisc", qty: 40, appr: 40 }] });
    const b = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 40 }] })).json();
    const items = await getItems();          // GET /items, for the standard cost
    expect(b.result.lines[0].rate).toBe(items.bisc.cost);
  });

  it("dates the order from the vendor's lead time", async () => {
    const v = await given.vendor(app.testDb!.db, { n: "Lead Time Traders", lead: 5, groups: ["Grocery"] });
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "sugar", qty: 10, appr: 10 }] });
    const b = (await post("u5", "/purchase-orders", { vendorId: v, picks: [{ prq, line: 0, qty: 10 }] })).json();
    expect(b.result.eta).toBe(etaFrom(new Date(), 5));
  });

  it("merges two requisitions' worth of the same item into one line carrying both sources", async () => {
    const a = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 25, appr: 25 }] });
    const c = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const b = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [
      { prq: a, line: 0, qty: 25 }, { prq: c, line: 0, qty: 80 },
    ] })).json();
    expect(b.result.lines).toHaveLength(1);
    expect(b.result.lines[0].qty).toBe(105);
    expect(b.result.lines[0].src).toEqual([{ prq: a, line: 0, qty: 25 }, { prq: c, line: 0, qty: 80 }]);
    expect(await pending(a, 0)).toBe(0);
    expect(await pending(c, 0)).toBe(0);
  });

  it("refuses two picks against one source line whose total overruns what is pending", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const r = await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [
      { prq, line: 0, qty: 50 }, { prq, line: 0, qty: 50 },
    ] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`Milk 1L (toned) — only 80.000 still pending on ${prq}`);
    expect(await pending(prq, 0)).toBe(80);
  });

  it("refuses a pick against a requisition nobody has approved", async () => {
    const prq = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 80 }] });   // still Sent
    expect((await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 1 }] })).json().error.message)
      .toBe(`Milk 1L (toned) — only 0.000 still pending on ${prq}`);
  });

  it("refuses an empty order, a zero pick, an unknown vendor and an inactive one", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    expect((await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [] })).json().error.message)
      .toBe("Pick at least one line before raising an order");
    expect((await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 0 }] })).json().error.message)
      .toBe("Enter a quantity on every line you pick");
    expect((await post("u5", "/purchase-orders", { vendorId: "VN-999", picks: [{ prq, line: 0, qty: 1 }] })).json().error.message)
      .toBe("Choose a vendor for this order");
    const off = await given.vendor(app.testDb!.db, { n: "Closed Traders", active: false });
    expect((await post("u5", "/purchase-orders", { vendorId: off, picks: [{ prq, line: 0, qty: 1 }] })).json().error.message)
      .toBe("Closed Traders is inactive — reactivate it or choose another vendor");
    expect(await pending(prq, 0)).toBe(80);
  });

  it("404s a requisition line that is not there, and is absent for every other role", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    expect((await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 7, qty: 1 }] })).json().error.message)
      .toBe(`There is no line 7 on ${prq}.`);
    for (const u of ["u1", "u2", "u3", "u4"]) {
      expect((await post(u, "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 1 }] })).statusCode).toBe(404);
    }
  });

  it("404s a requisition that is not there at all", async () => {
    expect((await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq: "PRQ-2026-777", line: 0, qty: 1 }] })).json().error.message)
      .toBe("There is no requisition PRQ-2026-777.");
  });

  it("lets only one of two drafts claim the last of a line", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 80 }] }),
      post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 80 }] }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    expect(await pending(prq, 0)).toBe(0);
  });
});

describe("PATCH and DELETE on a draft's lines", () => {
  const draft = async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 60 }] })).json().result.id;
    return { prq, id };
  };

  it("gives the difference back when a line is cut", async () => {
    const { prq, id } = await draft();
    const b = (await patch("u5", `/purchase-orders/${id}/lines/0`, { qty: 40 })).json();
    expect(b.result.lines[0]).toMatchObject({ qty: 40, src: [{ prq, line: 0, qty: 40 }] });
    expect(b.changed).toEqual(["po", "prq"]);
    expect(b.message).toBe("Milk 1L (toned) cut to 40.000 — 20.000 back on the procurement list");
    expect(await pending(prq, 0)).toBe(40);
  });

  it("releases the last source first when a line is funded by several", async () => {
    const a = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 25, appr: 25 }] });
    const c = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [
      { prq: a, line: 0, qty: 25 }, { prq: c, line: 0, qty: 80 },
    ] })).json().result.id;
    const b = (await patch("u5", `/purchase-orders/${id}/lines/0`, { qty: 75 })).json();
    expect(b.result.lines[0].src).toEqual([{ prq: a, line: 0, qty: 25 }, { prq: c, line: 0, qty: 50 }]);
    expect(await pending(a, 0)).toBe(0);
    expect(await pending(c, 0)).toBe(30);
  });

  it("refuses a quantity larger than the line, one of nothing, and a patch that says nothing", async () => {
    const { prq, id } = await draft();
    expect((await patch("u5", `/purchase-orders/${id}/lines/0`, { qty: 80 })).json().error.message)
      .toBe("Add another pick from the procurement list to increase this line");
    expect((await patch("u5", `/purchase-orders/${id}/lines/0`, { qty: 0 })).json().error.message)
      .toBe("Enter a quantity, or remove the line");
    const empty = await patch("u5", `/purchase-orders/${id}/lines/0`, {});
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.message).toBe("Nothing to change on this line");
    expect(await pending(prq, 0)).toBe(20);
  });

  it("edits a rate without touching the claim, and does not tell the list to refetch", async () => {
    const { prq, id } = await draft();
    const b = (await patch("u5", `/purchase-orders/${id}/lines/0`, { rate: 58 })).json();
    expect(b.result.lines[0]).toMatchObject({ qty: 60, rate: 58 });
    expect(b.changed).toEqual(["po"]);
    expect(b.message).toBe("Milk 1L (toned) at ₹58.00");
    expect(await pending(prq, 0)).toBe(20);
  });

  it("applies a quantity and a rate sent together, and names both", async () => {
    const { prq, id } = await draft();
    const b = (await patch("u5", `/purchase-orders/${id}/lines/0`, { qty: 45, rate: 51.5 })).json();
    expect(b.result.lines[0]).toMatchObject({ qty: 45, rate: 51.5, src: [{ prq, line: 0, qty: 45 }] });
    expect(b.changed).toEqual(["po", "prq"]);
    expect(b.message).toBe("Milk 1L (toned) cut to 45.000 at ₹51.50 — 15.000 back on the procurement list");
    expect(await pending(prq, 0)).toBe(35);
  });

  it("removes a line, gives its whole claim back, and closes the gap in the numbering", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [
      { it: "milk", qty: 80, appr: 80 }, { it: "butter", qty: 6, appr: 6 },
    ] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [
      { prq, line: 0, qty: 60 }, { prq, line: 1, qty: 6 },
    ] })).json().result.id;
    const b = (await del("u5", `/purchase-orders/${id}/lines/0`)).json();
    expect(b.result.lines).toHaveLength(1);
    expect(b.result.lines[0]).toMatchObject({ it: "butter", qty: 6 });   // now line 0
    expect(b.message).toBe("Milk 1L (toned) returned to the procurement list");
    expect(await pending(prq, 0)).toBe(80);
    // and the surviving line is still addressable at its new index
    expect((await patch("u5", `/purchase-orders/${id}/lines/0`, { rate: 260 })).statusCode).toBe(200);
  });

  it("will not touch a line once the order has gone out", async () => {
    const id = await given.po(app.testDb!.db, { st: "Ordered", lines: [{ it: "milk", qty: 80 }] });
    expect((await patch("u5", `/purchase-orders/${id}/lines/0`, { qty: 40 })).json().error.message)
      .toBe(`${id} is ordered — only a draft can be changed`);
    expect((await del("u5", `/purchase-orders/${id}/lines/0`)).json().error.message)
      .toBe(`${id} is ordered — only a draft can be changed`);
  });

  it("404s a line that is not there, and an order that is not there", async () => {
    const { id } = await draft();
    expect((await patch("u5", `/purchase-orders/${id}/lines/9`, { qty: 1 })).json().error.message)
      .toBe(`There is no line 9 on ${id}.`);
    expect((await patch("u5", "/purchase-orders/PO-2026-7777/lines/0", { qty: 1 })).json().error.message)
      .toBe("There is no purchase order PO-2026-7777.");
  });
});

describe("PATCH /purchase-orders/:id", () => {
  it("moves a draft to another vendor, re-prices it off that vendor's contracts and re-dates it", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "juice", qty: 120, appr: 120 }] });
    // VN-001 has no juice contract, so the line starts on the item's own cost of 14.2.
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 120 }] })).json().result.id;
    // VN-002 does: RC-103, juice at 14.2 — pick a rate the contract genuinely moves.
    await app.testDb!.db.update(rateContracts).set({ rate: 13.8 }).where(eq(rateContracts.id, "RC-103"));
    const b = (await patch("u5", `/purchase-orders/${id}`, { vendorId: "VN-002" })).json();
    expect(b.result.vendor).toBe("VN-002");
    expect(b.result.lines[0].rate).toBe(13.8);
    expect(b.result.eta).toBe(etaFrom(new Date(), 3));       // VN-002's lead time
    expect(b.changed).toEqual(["po"]);
    expect(b.message).toBe(`${id} moved to Sri Balaji Distributors — expected ${dmy(b.result.eta)}`);
  });

  it("leaves a rate the buyer negotiated alone when the vendor moves", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "juice", qty: 120, appr: 120 }] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 120 }] })).json().result.id;
    await patch("u5", `/purchase-orders/${id}/lines/0`, { rate: 12 });
    const b = (await patch("u5", `/purchase-orders/${id}`, { vendorId: "VN-002" })).json();
    expect(b.result.lines[0].rate).toBe(12);
  });

  it("moves the expected date at any open status, and nowhere else", async () => {
    const ordered = await given.po(app.testDb!.db, { st: "Ordered", lines: [{ it: "milk", qty: 80 }] });
    const b = (await patch("u5", `/purchase-orders/${ordered}`, { eta: "2026-09-30" })).json();
    expect(b.result.eta).toBe("2026-09-30");
    expect(b.message).toBe(`${ordered} expected 30-Sep-2026`);

    expect((await patch("u5", `/purchase-orders/${ordered}`, { vendorId: "VN-002" })).json().error.message)
      .toBe(`${ordered} is ordered — its vendor cannot change`);

    const done = await given.po(app.testDb!.db, { st: "Received", lines: [{ it: "milk", qty: 80, recv: 80 }] });
    expect((await patch("u5", `/purchase-orders/${done}`, { eta: "2026-09-30" })).json().error.message)
      .toBe(`${done} is received — nothing more is expected`);
  });

  it("refuses a patch that says nothing", async () => {
    const id = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 80 }] });
    expect((await patch("u5", `/purchase-orders/${id}`, {})).json().error.message).toBe(`Nothing to change on ${id}`);
  });

  it("refuses a vendor nobody has on file, and one that is closed", async () => {
    const id = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 80 }] });
    expect((await patch("u5", `/purchase-orders/${id}`, { vendorId: "VN-999" })).json().error.message)
      .toBe("Choose a vendor for this order");
    const off = await given.vendor(app.testDb!.db, { n: "Shuttered Supplies", active: false });
    expect((await patch("u5", `/purchase-orders/${id}`, { vendorId: off })).json().error.message)
      .toBe("Shuttered Supplies is inactive — reactivate it or choose another vendor");
  });
});

describe("POST /purchase-orders/:id/send", () => {
  it("sends a draft, stamps the slab and names the expected date", async () => {
    const id = await given.po(app.testDb!.db, { eta: "2026-09-11", lines: [{ it: "milk", qty: 80, rate: 54 }] });
    const b = (await post("u5", `/purchase-orders/${id}/send`)).json();
    expect(b.result).toMatchObject({ st: "Ordered", needsApproval: false });
    expect(b.result.hist.at(-1)).toMatchObject({ s: "Ordered", who: "Latha Narayanan" });
    expect(b.changed).toEqual(["po"]);
    expect(b.message).toBe(`${id} raised on Aavin Dairy Depot — expected 11-Sep-2026`);
  });

  it("flags an order over the finance slab but still sends it", async () => {
    const id = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 1000, rate: 54 }] });   // ₹54,000
    const b = (await post("u5", `/purchase-orders/${id}/send`)).json();
    expect(b.result).toMatchObject({ st: "Ordered", needsApproval: true });
    expect(b.message).toBe(`${id} raised on Aavin Dairy Depot — ₹54,000 is over the ₹25,000 slab and needs finance approval`);
  });

  it("refuses an empty order, an inactive vendor and a second send", async () => {
    // Emptied through the module's own DELETE rather than built empty: `given.po` writes its
    // lines in one insert, which drizzle refuses with no values — and a draft whose last line
    // was removed is how a buyer actually arrives at this refusal.
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 4, appr: 4 }] });
    const empty = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 4 }] })).json().result.id;
    await del("u5", `/purchase-orders/${empty}/lines/0`);
    expect((await post("u5", `/purchase-orders/${empty}/send`)).json().error.message)
      .toBe(`${empty} has no lines — add some from the procurement list`);

    const off = await given.vendor(app.testDb!.db, { n: "Closed Traders", active: false });
    const bad = await given.po(app.testDb!.db, { vendor: off, lines: [{ it: "milk", qty: 1 }] });
    expect((await post("u5", `/purchase-orders/${bad}/send`)).json().error.message)
      .toBe("Closed Traders is inactive — reactivate it or move this order to another vendor");

    const id = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 1 }] });
    await post("u5", `/purchase-orders/${id}/send`);
    expect((await post("u5", `/purchase-orders/${id}/send`)).json().error.message).toBe(`${id} is already ordered`);
  });

  it("sends once when two screens press together", async () => {
    const id = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 1 }] });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([post("u5", `/purchase-orders/${id}/send`), post("u5", `/purchase-orders/${id}/send`)]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const hist = (await pos()).find((o: { id: string }) => o.id === id).hist;
    expect(hist.filter((h: { s: string }) => h.s === "Ordered")).toHaveLength(1);
  });
});

describe("POST /purchase-orders/:id/cancel", () => {
  it("cancels an order and puts every claim back on the list", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 60 }] })).json().result.id;
    await post("u5", `/purchase-orders/${id}/send`);
    const b = (await post("u5", `/purchase-orders/${id}/cancel`, { reason: "Vendor cannot supply this week" })).json();
    expect(b.result).toMatchObject({ st: "Cancelled", shortNote: "Vendor cannot supply this week" });
    expect(b.changed).toEqual(["po", "prq"]);
    expect(b.message).toBe(`${id} cancelled — 1 line(s) back on the procurement list`);
    expect(await pending(prq, 0)).toBe(80);
  });

  it("will not cancel once anything has arrived, and says what to do instead", async () => {
    const id = await given.po(app.testDb!.db, { st: "Partially received", lines: [{ it: "milk", qty: 80, recv: 60 }] });
    const r = await post("u5", `/purchase-orders/${id}/cancel`, { reason: "Changed my mind" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} already received against — close it short instead of cancelling`);
  });

  it("wants a reason, and will not cancel twice", async () => {
    const id = await given.po(app.testDb!.db, { lines: [{ it: "milk", qty: 80 }] });
    expect((await post("u5", `/purchase-orders/${id}/cancel`, { reason: "  " })).json().error.message)
      .toBe("Give a reason for cancelling this order");
    await post("u5", `/purchase-orders/${id}/cancel`, { reason: "No" });
    expect((await post("u5", `/purchase-orders/${id}/cancel`, { reason: "No" })).json().error.message)
      .toBe(`${id} is already cancelled`);
  });

  it("gives a claim back exactly once when two screens cancel together", async () => {
    const prq = await given.requisition(app.testDb!.db, { st: "Approved", lines: [{ it: "milk", qty: 80, appr: 80 }] });
    const id = (await post("u5", "/purchase-orders", { vendorId: "VN-001", picks: [{ prq, line: 0, qty: 60 }] })).json().result.id;
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u5", `/purchase-orders/${id}/cancel`, { reason: "a" }),
      post("u5", `/purchase-orders/${id}/cancel`, { reason: "b" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await pending(prq, 0)).toBe(80);        // 80, not 140
  });
});
