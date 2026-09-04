// The builders are the fixture every wave-3 suite writes its cases against, so their defaults
// are pinned here rather than rediscovered three times: what id they draw, what a request
// carries when nothing is said about it, and which ticket statuses hold their stock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SEQUENCE_START, makeOtp } from "@rch/domain";
import { withTestSchema, truncateAll, type TestDb } from "./db.js";
import { seedTestDb } from "./seed.js";
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
});
