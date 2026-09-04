import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeOtp } from "@rch/domain";
import { withTestSchema, truncateAll, type TestDb } from "../test/db.js";
import { seedDatabase } from "../db/seed.js";
import { reservations } from "../db/schema/index.js";
import { allocateTicket, readTicket, writeTicket } from "./tickets.js";

let t: TestDb;
beforeAll(async () => { t = await withTestSchema("tickets_lib"); });
afterAll(async () => { await t.close(); });
beforeEach(async () => { await truncateAll(t.db); await seedDatabase(t.db, { password: "changeme", forcePasswordChange: false, force: true }); });

describe("allocateTicket + writeTicket", () => {
  it("continues the visible series, mints the OTP from the same number, and reserves the lines", async () => {
    const tkt = await t.db.transaction(async (tx) => {
      // Ids first, balance rows second — the caller would take the locks between these two.
      const no = await allocateTicket(tx);
      return writeTicket(tx, { refType: "request", refId: "REQ-2026-0911", from: "store", to: "coffee", lines: [{ it: "milk", qty: 12 }], by: "u3" }, no);
    });
    expect(tkt.id).toBe("TKT-0441");                  // SEQUENCE_START.tkt is 441
    expect(tkt.otp).toBe(makeOtp(441));
    expect(tkt.otp).toMatch(/^\d{6}$/);
    expect(tkt).toEqual({ id: "TKT-0441", req: "REQ-2026-0911", from: "store", to: "coffee", lines: [{ it: "milk", qty: 12 }], st: "Issued", otp: makeOtp(441) });

    const held = await t.db.select().from(reservations).where(eq(reservations.ticketId, "TKT-0441"));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ loc: "store", itemKey: "milk", qty: 12, releasedAt: null });
  });

  it("folds a repeated item into one line before it reserves", async () => {
    const tkt = await t.db.transaction(async (tx) =>
      writeTicket(tx, { refType: "shop_transfer", refId: "Shop transfer", from: "coffee", to: "kiosk", lines: [{ it: "chips", qty: 2 }, { it: "chips", qty: 4 }], by: "u1" }, await allocateTicket(tx)));
    expect(tkt.lines).toEqual([{ it: "chips", qty: 6 }]);
    const held = await t.db.select().from(reservations).where(eq(reservations.ticketId, tkt.id));
    expect(held).toHaveLength(1);
    expect(held[0].qty).toBe(6);
  });

  it("reads a ticket back in the wire shape, and nothing for an id that is not there", async () => {
    const made = await t.db.transaction(async (tx) =>
      writeTicket(tx, { refType: "direct", refId: "Direct issue", from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: 5 }], by: "u4" }, await allocateTicket(tx)));
    expect(await t.db.transaction((tx) => readTicket(tx, made.id))).toEqual(made);
    expect(await t.db.transaction((tx) => readTicket(tx, "TKT-0000"))).toBeUndefined();
  });
});
