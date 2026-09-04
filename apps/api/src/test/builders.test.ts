// The builders are the fixture every wave-3 suite writes its cases against, so their defaults
// are pinned here rather than rediscovered three times: what id they draw, what a request
// carries when nothing is said about it, and which ticket statuses hold their stock.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEQUENCE_START, makeOtp } from "@rch/domain";
import { withTestSchema, truncateAll, type TestDb } from "./db.js";
import { seedTestDb } from "./seed.js";
import * as s from "../db/schema/index.js";
import { readHistory } from "../lib/history.js";
import { reservedAt } from "../lib/reservations.js";
import { readTicket } from "../lib/tickets.js";
import { readRequests, readShopAsks } from "../modules/snapshot/readers/documents.js";
import { given } from "./builders.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("builders"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await truncateAll(t.db); await seedTestDb(t.db); });

describe("given", () => {
  it("draws ids above the seeded documents and above the number the sequence would hand out next", async () => {
    const req = await given.request(t.db, { from: "coffee", lines: [{ it: "cup", qty: 200 }] });
    const tkt = await given.ticket(t.db, { from: "store", to: "coffee", lines: [{ it: "cup", qty: 200 }] });
    const ask = await given.shopAsk(t.db, { from: "coffee", to: "kiosk", it: "chips", qty: 6 });
    expect(Number(req.slice("REQ-2026-0".length))).toBeGreaterThan(SEQUENCE_START.req);
    expect(Number(tkt.slice("TKT-0".length))).toBeGreaterThan(SEQUENCE_START.tkt);
    expect(Number(ask.slice("ASK-0".length))).toBeGreaterThan(SEQUENCE_START.shop_ask);
  });

  it("writes a request with its lines, the asker's name and its first history entry", async () => {
    const id = await given.request(t.db, {
      from: "kiosk", by: "u6", lines: [{ it: "water", qty: 24, appr: 12 }],
      st: "Partially approved", mgrNote: "Store only holds 12.", urgent: true,
    });
    const r = (await readRequests(t.db)).find((x) => x.id === id)!;
    expect(r).toMatchObject({ from: "kiosk", by: "Deepa Selvam", st: "Partially approved", mgrNote: "Store only holds 12.", urg: true, ticket: null });
    expect(r.lines).toEqual([{ it: "water", qty: 24, appr: 12 }]);
    expect(r.hist.map((h) => h.s)).toEqual(["Request sent"]);
  });

  it("holds an Issued ticket's stock and leaves a Collected one's alone", async () => {
    const issued = await given.ticket(t.db, { from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: 5 }] });
    const collected = await given.ticket(t.db, { from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: 7 }], st: "Collected" });
    expect(await t.db.transaction((tx) => reservedAt(tx, "kitchen", ["puff"]))).toEqual({ "kitchen:puff": 5 });
    expect(await t.db.transaction((tx) => readTicket(tx, issued))).toMatchObject({ st: "Issued", otp: makeOtp(700), lines: [{ it: "puff", qty: 5 }] });
    expect(await t.db.transaction((tx) => readTicket(tx, collected))).toMatchObject({ st: "Collected", from: "kitchen", to: "kiosk" });
  });

  it("writes a shop ask nobody has answered yet", async () => {
    const id = await given.shopAsk(t.db, { from: "coffee", to: "kiosk", it: "chips", qty: 6, note: "Lunch rush cleared us out" });
    const ask = (await readShopAsks(t.db)).find((a) => a.id === id)!;
    expect(ask).toMatchObject({ from: "coffee", to: "kiosk", it: "chips", qty: 6, st: "Asked", by: "Kavitha Raman", note: "Lunch rush cleared us out" });
    expect(ask.grant).toBeUndefined();
    expect(ask.ticket).toBeUndefined();
  });

  it("writes a vendor above the fixtures' band and the sequence's start", async () => {
    const id = await given.vendor(t.db, { n: "New Fixture Distributors", lead: 5, groups: ["Beverages"] });
    expect(Number(id.replace("VN-", ""))).toBeGreaterThan(SEQUENCE_START.vendor);
    const [row] = await t.db.select().from(s.vendors).where(eq(s.vendors.id, id));
    expect(row).toMatchObject({ name: "New Fixture Distributors", leadDays: 5, groups: ["Beverages"], active: true });
  });

  it("writes a requisition with its lines and first history entry", async () => {
    const id = await given.requisition(t.db, { lines: [{ it: "milk", qty: 40, appr: 30 }], note: "Weekly top-up" });
    expect(Number(id.replace("PRQ-2026-", ""))).toBeGreaterThan(SEQUENCE_START.prq);
    const [row] = await t.db.select().from(s.requisitions).where(eq(s.requisitions.id, id));
    expect(row).toMatchObject({ status: "Sent", note: "Weekly top-up" });
    const lines = await t.db.select().from(s.requisitionLines).where(eq(s.requisitionLines.requisitionId, id));
    expect(lines).toMatchObject([{ itemKey: "milk", qty: 40, approvedQty: 30 }]);
    const hist = await readHistory(t.db, "requisition", id);
    expect(hist.map((h) => h.s)).toEqual(["Sent"]);
  });

  it("writes a purchase order with its lines, sources and first history entry", async () => {
    const prq = await given.requisition(t.db, { lines: [{ it: "cup", qty: 500, appr: 500 }] });
    const id = await given.po(t.db, { st: "Ordered", lines: [{ it: "cup", qty: 500, rate: 0.6, src: [{ prq, line: 0, qty: 500 }] }] });
    expect(Number(id.replace("PO-2026-", ""))).toBeGreaterThan(SEQUENCE_START.po);
    const [row] = await t.db.select().from(s.purchaseOrders).where(eq(s.purchaseOrders.id, id));
    expect(row).toMatchObject({ vendorId: "VN-001", status: "Ordered" });
    const lines = await t.db.select().from(s.poLines).where(eq(s.poLines.poId, id));
    expect(lines).toMatchObject([{ itemKey: "cup", qty: 500, rate: 0.6, receivedQty: 0, rejectedQty: 0 }]);
    const srcs = await t.db.select().from(s.poLineSources).where(eq(s.poLineSources.poId, id));
    expect(srcs).toMatchObject([{ requisitionId: prq, requisitionLineNo: 0, qty: 500 }]);
    const hist = await readHistory(t.db, "purchase_order", id);
    expect(hist.map((h) => h.s)).toEqual(["Ordered"]);
  });

  it("writes a rate contract live by default", async () => {
    const id = await given.contract(t.db, { it: "juice", rate: 15 });
    expect(Number(id.replace("RC-", ""))).toBeGreaterThan(SEQUENCE_START.contract);
    const [row] = await t.db.select().from(s.rateContracts).where(eq(s.rateContracts.id, id));
    expect(row).toMatchObject({ vendorId: "VN-001", itemKey: "juice", rate: 15, active: true, moq: 0 });
  });

  it("writes a product request awaiting the store's answer", async () => {
    const id = await given.productRequest(t.db, { name: "Turmeric latte mix", by: "u2", forLoc: "coffee" });
    expect(Number(id.replace("NPR-", ""))).toBeGreaterThan(SEQUENCE_START.product_req);
    const [row] = await t.db.select().from(s.productRequests).where(eq(s.productRequests.id, id));
    expect(row).toMatchObject({ name: "Turmeric latte mix", byUser: "u2", forLoc: "coffee", status: "Requested" });
  });

  it("makes a support ticket with a first message, above the fixtures' band", async () => {
    const id = await given.supportTicket(t.db, { by: "u1", subject: "Cash reads zero", messages: [{ from: "user", body: "Since 09:00." }] });
    expect(id).toMatch(/^SUP-00\d+$/);
    // The fixtures stop at SUP-0043 and the sequence starts at 44; `nextId` pads to four, so the
    // builder's band is SUP-000101+ — above both, and a builder-made ticket can collide with
    // neither a seeded one nor an allocated one.
    expect(Number(id.slice(-3))).toBeGreaterThan(100);

    const rows = await t.db.select().from(s.supportTickets).where(eq(s.supportTickets.id, id));
    expect(rows[0]?.status).toBe("Open");
    expect(rows[0]?.byUser).toBe("u1");
    const msgs = await t.db.select().from(s.supportMessages).where(eq(s.supportMessages.ticketId, id));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.from).toBe("user");
  });

  it("draws a second ticket without colliding with the first", async () => {
    const a = await given.supportTicket(t.db, { by: "u1", subject: "One" });
    const b = await given.supportTicket(t.db, { by: "u1", subject: "Two" });
    expect(a).not.toBe(b);
  });
});
