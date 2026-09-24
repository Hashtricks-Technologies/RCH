import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { BillSchema } from "@rch/contract";
import type { App } from "../app.js";
import * as s from "../db/schema/index.js";
import { buildTestApp } from "../test/app.js";
import { given } from "../test/builders.js";
import { seedTestDb } from "../test/seed.js";
import { withTransaction } from "./db.js";
import { assertSellable, cartOf, menuOf, postSale, sellableAt } from "./sale.js";
import { systemOperator } from "./system-users.js";

/** `postSale` is the till's sale (pos.test.ts drives it through `POST /bills`); these cases are
 *  what the till never does - a QR capture's bill - and the menu readers the public menu uses. */
let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "sale" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("postSale for a QR capture", () => {
  it("raises an ordinary bill as the system account, tendered Online, naming the order it fills", async () => {
    const qo = await given.qrOrder(app.db, { loc: "coffee", lines: [{ it: "juice", qty: 2, rate: 20 }] });
    const out = await withTransaction(app.db, async (tx) => postSale(tx, {
      loc: "coffee", operatorId: await systemOperator(tx), lines: [{ it: "juice", qty: 2 }], tender: "Online",
      customer: { name: "Asha", phone: "98765 43210" }, source: "qr", qrOrderId: qo,
    }));
    expect(BillSchema.safeParse(out.result).success).toBe(true);
    expect(out.result).toMatchObject({ loc: "coffee", pay: "Online", opr: "QR Orders", tot: 40, src: "qr", qo, customerName: "Asha", customerPhone: "9876543210" });
    expect(out.changed).toEqual(["stock", "bills"]);
    expect(out.message).toBe(`Bill ${out.result.no} · ₹40.00 settled by online at Coffee Shop`);
    const [row] = await app.db.select().from(s.bills).where(eq(s.bills.no, out.result.no));
    expect(row).toMatchObject({ source: "qr", qrOrderId: qo, operatorId: "sys-qr", tender: "Online" });
    const moves = await app.db.select().from(s.stockMoves).where(and(eq(s.stockMoves.refType, "bill"), eq(s.stockMoves.refId, out.result.no)));
    expect(moves.map((m) => [m.loc, m.itemKey, m.qty, m.kind, m.byUser])).toEqual([["coffee", "juice", -2, "sale", "sys-qr"]]);
  });
  it("refuses a second bill for the same order - the database decides", async () => {
    const qo = await given.qrOrder(app.db, { loc: "coffee", lines: [{ it: "chips", qty: 1, rate: 20 }] });
    const sell = () => withTransaction(app.db, async (tx) => postSale(tx, {
      loc: "coffee", operatorId: await systemOperator(tx), lines: [{ it: "chips", qty: 1 }], tender: "Online", source: "qr", qrOrderId: qo,
    }));
    await sell();
    await expect(sell()).rejects.toMatchObject({ cause: { constraint: "bills_qr_order_uq" } });
  });
  it("keeps a till bill's wire shape as it was: no source, no order", async () => {
    const out = await withTransaction(app.db, async (tx) => postSale(tx, { loc: "coffee", operatorId: "u1", lines: [{ it: "chips", qty: 1 }], tender: "Cash", source: "till" }));
    expect(out.result).not.toHaveProperty("src");
    expect(out.result).not.toHaveProperty("qo");
  });
});

describe("the menu readers", () => {
  it("lists the outlet's menu at the till's price, capped at the MRP, with why a line is not available", async () => {
    await app.db.insert(s.availabilityOverrides).values({ loc: "coffee", itemKey: "bisc", reason: "Switched off by the counter" })
      .onConflictDoUpdate({ target: [s.availabilityOverrides.loc, s.availabilityOverrides.itemKey], set: { reason: "Switched off by the counter" } });
    const [coffee] = await app.db.select().from(s.locations).where(eq(s.locations.key, "coffee"));
    // Juice listed above its printed MRP: the menu shows what the till would charge.
    await app.db.update(s.items).set({ mrp: 18 }).where(eq(s.items.key, "juice"));
    try {
      const sellable = await sellableAt(app.db, "coffee");
      const menu = menuOf(sellable);
      expect(menu.map((l) => l.item.n)).toEqual(menu.map((l) => l.item.n).sort((a, b) => a.localeCompare(b)));
      const juice = menu.find((l) => l.it === "juice")!;
      expect(juice).toMatchObject({ price: 18, mrp: 18, available: true });
      expect(juice.cover).toBeGreaterThan(0);
      expect(menu.find((l) => l.it === "bisc")).toMatchObject({ available: false, why: "Switched off by the counter" });
      // A listed item with no price on the outlet's list reads as unavailable, in the till's words.
      const listed = [...sellable.menu][0];
      const unpriced = { ...sellable, prices: { ...sellable.prices, [coffee.priceListId!]: {} } };
      expect(menuOf(unpriced).find((l) => l.it === listed)).toMatchObject({ available: false, why: `${sellable.master.items[listed].n} has no price at Coffee Shop` });
      expect(() => assertSellable(unpriced, { [listed]: 1 })).toThrow(/has no price at Coffee Shop/);
      // A menu row for an item the master no longer sells is left out.
      expect(menuOf({ ...sellable, menu: new Set([...sellable.menu, "retired-item"]) }).some((l) => l.it === "retired-item")).toBe(false);
    } finally {
      await app.db.update(s.items).set({ mrp: null }).where(eq(s.items.key, "juice"));
      await app.db.delete(s.availabilityOverrides).where(and(eq(s.availabilityOverrides.loc, "coffee"), eq(s.availabilityOverrides.itemKey, "bisc")));
    }
  });
  it("refuses what the till refuses, in its words", async () => {
    const sellable = await sellableAt(app.db, "coffee");
    expect(() => assertSellable(sellable, { nope: 1 })).toThrow("There is no item nope.");
    expect(() => assertSellable({ ...sellable, menu: new Set() }, { juice: 1 })).toThrow("is not listed at Coffee Shop");
    expect(() => assertSellable(sellable, { juice: 1_000_000 })).toThrow(/^Only .* left at Coffee Shop$/);
    const noList = { ...sellable, master: { ...sellable.master, locations: { ...sellable.master.locations, coffee: { ...sellable.master.locations.coffee, list: undefined } } } };
    expect(() => assertSellable(noList, { juice: 1 })).toThrow("Refused - Coffee Shop is on no price list; attach one from Prices before selling");
    expect(cartOf([{ it: "juice", qty: 1 }, { it: "juice", qty: 0.5 }, { it: "chips", qty: 2 }])).toEqual({ juice: 1.5, chips: 2 });
  });
});
