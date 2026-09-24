import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { RegisterReportSchema, RegisterReportsResponseSchema, type AdminRole, type Permissions } from "@rch/contract";
import { DESK_DEFAULTS } from "@rch/domain";
import * as s from "../../db/schema/index.js";
import { postMoves } from "../../lib/ledger.js";
import { buildTestApp } from "../../test/app.js";
import { given } from "../../test/builders.js";
import { resetDocuments, warmPool } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import type { App } from "../../app.js";

let app: App;

/** u7 (RC-0001) is the seed's super admin: it makes the roles and the accounts these cases need. */
const asAdmin = async (method: InjectOptions["method"], url: string, payload: Record<string, unknown>) => {
  const r = await app.inject({ method, url: `/api/v1${url}`, headers: { ...(await authHeaders(app, "u7")), "idempotency-key": randomUUID() }, payload });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().result as { id: string };
};
const newRole = async (name: string, desk: AdminRole["desk"], perms: Permissions) => (await asAdmin("POST", "/admin/roles", { name, desk, perms })).id;
/** A fresh account on a role, at a location, past its first-sign-in password change - its id,
 *  to mint a token for. */
const hire = async (name: string, roleId: string, loc: string) => {
  const { id } = await asAdmin("POST", "/admin/users", { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@royalcare.in`, roleId, loc });
  await app.db.update(s.users).set({ mustChangePassword: false }).where(eq(s.users.id, id));
  return id;
};

/** No seeded role holds the Z - it is the super admin's until a role is given it. The two seeded
 *  counters here are moved onto a counter role that also holds it, so every case that is about
 *  the Z itself, rather than about who may take one, runs as the till that took the bills. */
const counterWithZ: Permissions = { f: { ...DESK_DEFAULTS.counter.perms.f, z_report: "edit" }, a: [] };
beforeAll(async () => {
  app = await buildTestApp({ schema: "register" });
  await seedTestDb(app.testDb!.db);
  await app.ready();
  const zRole = await newRole("Counter Operator with Z", "counter", counterWithZ);
  await asAdmin("PATCH", "/admin/users/u1", { roleId: zRole, loc: "coffee" });
  await asAdmin("PATCH", "/admin/users/u6", { roleId: zRole, loc: "kiosk" });
});
afterAll(async () => { await app.close(); });

type PayBody = { loc: string; tender: string; payer?: { kind: string; id: string; name: string }; lines: { it: string; qty: number }[] };

const pay = async (userId: string, body: PayBody) =>
  app.inject({ method: "POST", url: "/api/v1/bills", headers: { ...(await authHeaders(app, userId)), "idempotency-key": randomUUID() }, payload: body });

const xReport = async (userId: string, loc?: string) =>
  app.inject({ method: "GET", url: `/api/v1/register/x${loc ? `?loc=${loc}` : ""}`, headers: await authHeaders(app, userId) });

const close = async (userId: string, body: { loc: string; countedCash?: number; note?: string }, key = randomUUID()) =>
  app.inject({ method: "POST", url: "/api/v1/register/close", headers: { ...(await authHeaders(app, userId)), "idempotency-key": key }, payload: { note: "", ...body } });

const zList = async (userId: string, q = "") =>
  app.inject({ method: "GET", url: `/api/v1/register/z${q}`, headers: await authHeaders(app, userId) });

const voidBill = async (userId: string, no: string, reason: string) =>
  app.inject({
    method: "POST", url: `/api/v1/bills/${encodeURIComponent(no)}/void`,
    headers: { ...(await authHeaders(app, userId)), "idempotency-key": randomUUID() }, payload: { reason },
  });

/** Enough on the shelf that no case in this file is ever about stock. A register test that goes
 *  red because the Coffee Shop ran out of biscuits is a register test nobody trusts. */
let topUps = 0;
const shelve = async (loc: string, it: string, qty: number) =>
  app.db.transaction((tx) => postMoves(tx, [{ loc, it, qty, kind: "adjustment", refType: "test", refId: `register-top-${++topUps}` }]));

/** Every case starts at "this outlet has never taken a Z" - `resetDocuments` now empties
 *  `register_sessions` for every suite, so a stray open session cannot become the next case's
 *  business day here or anywhere else. */
const reset = async () => {
  await resetDocuments(app.db);
  await shelve("coffee", "water", 200);
  await shelve("coffee", "chips", 200);
  await shelve("coffee", "bisc", 200);
  await shelve("kiosk", "water", 200);
};
beforeEach(reset);

const sessionsAt = async (loc: string) =>
  app.db.select().from(s.registerSessions).where(eq(s.registerSessions.loc, loc));
const openAt = async (loc: string) =>
  app.db.select().from(s.registerSessions).where(and(eq(s.registerSessions.loc, loc), isNull(s.registerSessions.closedAt)));

const Z_NO = /^Z-\d{4}-\d{4}$/;

describe("the business day opens itself on the first sale", () => {
  it("an outlet that has sold nothing has no session at all, and its X is a well-formed report of zeros", async () => {
    expect(await sessionsAt("coffee")).toEqual([]);

    const r = await xReport("u1");
    expect(r.statusCode, r.body).toBe(200);
    const rep = r.json();
    expect(RegisterReportSchema.safeParse(rep).success, JSON.stringify(rep)).toBe(true);
    expect(rep.kind).toBe("X");
    expect(rep.loc).toBe("coffee");
    expect(rep.zNo).toBeNull();
    // No id, because the first sale is what mints one - this describes the day that would be next.
    expect(rep.sessionId).toBe("");
    expect(rep.previousZNo).toBeNull();
    expect(rep.totals.nettSales).toBe(0);
    expect(rep.totals.billCount).toBe(0);
    expect(rep.totals.collected).toBe(0);
    expect(rep.totals.oldBillsTotal).toBe(0);
    expect(rep.takenBy).toBe("Kavitha Raman");

    // And reading it opened nothing: an X never writes.
    expect(await sessionsAt("coffee")).toEqual([]);
  });

  it("the first sale opens the session and the bill is stamped with it", async () => {
    const r = await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    expect(r.statusCode, r.body).toBe(200);
    const no = r.json().result.no;

    const open = await openAt("coffee");
    expect(open.length).toBe(1);
    expect(open[0].zNo).toBeNull();
    expect(open[0].openedBy).toBe("u1");

    const [bill] = await app.db.select().from(s.bills).where(eq(s.bills.no, no));
    expect(bill.sessionId).toBe(open[0].id);

    // A second sale joins the same day rather than starting another.
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "chips", qty: 1 }] });
    expect((await sessionsAt("coffee")).length).toBe(1);
  });

  it("a bill taken before the register existed carries no session and is left out of the takings", async () => {
    const old = await given.bill(app.db, { loc: "coffee", total: 500, tender: "Cash" });
    const [row] = await app.db.select().from(s.bills).where(eq(s.bills.no, old));
    expect(row.sessionId).toBeNull();

    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const rep = (await xReport("u1")).json();
    expect(rep.totals.nettSales).toBe(20);
    expect(rep.totals.billCount).toBe(1);
  });

  it("each outlet keeps its own day - the kiosk's first sale does not join the coffee shop's", async () => {
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    await pay("u6", { loc: "kiosk", tender: "Cash", lines: [{ it: "water", qty: 2 }] });

    const coffee = (await xReport("u1")).json();
    const kiosk = (await xReport("u6")).json();
    expect(coffee.sessionId).not.toBe(kiosk.sessionId);
    expect(coffee.totals.nettSales).toBe(20);
    expect(kiosk.totals.nettSales).toBe(36);   // List A, not the Coffee Shop's List B
  });
});

describe("an X is read as often as anyone likes and changes nothing", () => {
  it("two X-reports a moment apart answer the same figures over the same session", async () => {
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 2 }] });
    const before = await sessionsAt("coffee");

    const one = (await xReport("u1")).json();
    const two = (await xReport("u1")).json();

    // Everything but the clock, which is the one thing an X is honest about moving.
    const { takenAt: _a, ...restOne } = one;
    const { takenAt: _b, ...restTwo } = two;
    expect(restTwo).toEqual(restOne);
    expect(one.zNo).toBeNull();
    expect(one.closedAt).toBeNull();
    expect(one.totals.nettSales).toBe(40);

    // Not a row touched, and no number drawn: an X mints no Z.
    expect(await sessionsAt("coffee")).toEqual(before);
    const [seq] = await app.db.select().from(s.sequences).where(eq(s.sequences.kind, "z_report"));
    const one2 = (await xReport("u1")).json();
    expect(one2.zNo).toBeNull();
    const [after] = await app.db.select().from(s.sequences).where(eq(s.sequences.kind, "z_report"));
    expect(after.next).toBe(seq.next);
  });
});

describe("a Z closes the day, numbers it and stores what it printed", () => {
  it("closes the open session, stamps the Z on it and stores the totals", async () => {
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const [open] = await openAt("coffee");

    const r = await close("u1", { loc: "coffee", countedCash: 20, note: "Counted at the pass" });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(RegisterReportSchema.safeParse(body.result).success, JSON.stringify(body.result)).toBe(true);
    expect(body.result.kind).toBe("Z");
    expect(body.result.zNo).toMatch(Z_NO);
    expect(body.result.sessionId).toBe(open.id);
    expect(body.result.closedAt).toBe(body.result.takenAt);
    expect(body.result.previousZNo).toBeNull();
    expect(body.changed).toEqual(["bills"]);
    expect(body.message).toBe(`${body.result.zNo} closed the register at Coffee Shop - ₹20.00 nett over 1 bill, ₹20.00 collected · ₹20.00 counted, and the drawer agrees to the paisa`);

    const [row] = await sessionsAt("coffee");
    expect(row.zNo).toBe(body.result.zNo);
    expect(row.closedBy).toBe("u1");
    expect(row.closedAt).not.toBeNull();
    // Stored as printed, and carrying what the counter counted - the two the wire has no field
    // for ride in the same column and are stripped back off on the way out.
    const stored = row.closedTotals as Record<string, unknown>;
    expect(stored.nettSales).toBe(20);
    expect(stored.countedCash).toBe(20);
    expect(stored.note).toBe("Counted at the pass");

    // And the register is left with nothing open: the next session opens on the next sale.
    expect(await openAt("coffee")).toEqual([]);
  });

  it("names the drawer when the count does not agree", async () => {
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 5 }] });
    const short = await close("u1", { loc: "coffee", countedCash: 90 });
    expect(short.json().message).toContain("₹90.00 counted against ₹100.00 cash, ₹10.00 short");

    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 5 }] });
    const over = await close("u1", { loc: "coffee", countedCash: 130 });
    expect(over.json().message).toContain("₹130.00 counted against ₹100.00 cash, ₹30.00 over");

    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 5 }] });
    const uncounted = await close("u1", { loc: "coffee" });
    expect(uncounted.json().message).not.toContain("counted");
  });

  it("refuses when there is nothing to close, and mints no number doing it", async () => {
    const [seq] = await app.db.select().from(s.sequences).where(eq(s.sequences.kind, "z_report"));
    const r = await close("u1", { loc: "coffee" });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error.message).toBe("There is nothing to close at Coffee Shop - no sale has been taken since the last Z.");
    const [after] = await app.db.select().from(s.sequences).where(eq(s.sequences.kind, "z_report"));
    expect(after.next).toBe(seq.next);
  });

  it("a Z of nothing is refused even straight after a Z of something", async () => {
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    expect((await close("u1", { loc: "coffee" })).statusCode).toBe(200);
    const again = await close("u1", { loc: "coffee" });
    expect(again.statusCode, again.body).toBe(422);
    expect(again.json().error.message).toContain("no sale has been taken since the last Z");
  });

  it("the Z number is a gapless series shared across outlets, and each Z names the one before it at its own outlet", async () => {
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const c1 = (await close("u1", { loc: "coffee" })).json().result;
    await pay("u6", { loc: "kiosk", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const k1 = (await close("u6", { loc: "kiosk" })).json().result;
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const c2 = (await close("u1", { loc: "coffee" })).json().result;

    const n = (z: string) => Number(z.slice(-4));
    expect(n(k1.zNo)).toBe(n(c1.zNo) + 1);
    expect(n(c2.zNo)).toBe(n(k1.zNo) + 1);
    // The chain is per outlet, not per number: the coffee shop's second Z follows its first,
    // with the kiosk's in between on the series and nowhere on this chain.
    expect(c1.previousZNo).toBeNull();
    expect(k1.previousZNo).toBeNull();
    expect(c2.previousZNo).toBe(c1.zNo);
  });
});

describe("Z to Z - the reconciliation the whole table exists for", () => {
  it("counts only what came after the last Z, and leaves the last Z as it was printed", async () => {
    // Day one: two sales.
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });   // 20
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "chips", qty: 1 }] });   // 20
    const z1 = (await close("u1", { loc: "coffee" })).json().result;
    expect(z1.totals.nettSales).toBe(40);
    expect(z1.totals.billCount).toBe(2);

    // Day two opens on the next sale, not on the close.
    expect(await openAt("coffee")).toEqual([]);
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "bisc", qty: 1 }] });    // 30
    const [open] = await openAt("coffee");
    expect(open.id).not.toBe(z1.sessionId);

    const mid = (await xReport("u1")).json();
    expect(mid.totals.nettSales).toBe(30);
    expect(mid.previousZNo).toBe(z1.zNo);

    const z2 = (await close("u1", { loc: "coffee" })).json().result;
    expect(z2.sessionId).toBe(open.id);
    expect(z2.previousZNo).toBe(z1.zNo);
    // The whole point: day two is 30, not 70. A calendar day cannot say this - all three sales
    // and both Zs happened inside one IST day.
    expect(z2.totals.nettSales).toBe(30);
    expect(z2.totals.billCount).toBe(1);

    // And day one still reads 40 a Z later.
    const list = (await zList("u1")).json();
    expect(RegisterReportsResponseSchema.safeParse(list).success, JSON.stringify(list.slice(0, 1))).toBe(true);
    expect(list.map((r: { zNo: string }) => r.zNo)).toEqual([z2.zNo, z1.zNo]);
    expect(list[1].totals.nettSales).toBe(40);
    expect(list[0].totals.nettSales).toBe(30);
    expect(list[1].previousZNo).toBeNull();
    expect(list[0].previousZNo).toBe(z1.zNo);
    expect(list[0].takenBy).toBe("Kavitha Raman");
  });

  it("the list is read from what each Z stored, not worked out again from the bills", async () => {
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 3 }] });
    const z1 = (await close("u1", { loc: "coffee" })).json().result;
    expect(z1.totals.nettSales).toBe(60);

    // A bill the session's own SQL would count, added behind the Z's back. Re-derivation would
    // move the figure; a stored Z cannot.
    await app.db.insert(s.bills).values({
      no: "CF/99001", loc: "coffee", operatorId: "u1", total: 5000, tax: 0,
      at: new Date(), tender: "Cash", sessionId: z1.sessionId,
    });
    const list = (await zList("u1")).json();
    expect(list[0].totals.nettSales).toBe(60);
  });

  it("a window that starts after a Z still says which Z its oldest entry follows", async () => {
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const z1 = (await close("u1", { loc: "coffee" })).json().result;
    // Backdate the first close well outside a one-day window, so the list below cannot see it.
    await app.db.update(s.registerSessions)
      .set({ closedAt: new Date(Date.now() - 5 * 86_400_000) })
      .where(eq(s.registerSessions.id, z1.sessionId));

    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "chips", qty: 1 }] });
    const z2 = (await close("u1", { loc: "coffee" })).json().result;

    const list = (await zList("u1", "?days=1")).json();
    expect(list.map((r: { zNo: string }) => r.zNo)).toEqual([z2.zNo]);
    expect(list[0].previousZNo).toBe(z1.zNo);
  });
});

describe("the totals reconcile", () => {
  it("nett is the tender lines added up, collected and credit split between them, and the GST halves add to the tax", async () => {
    const cash = (await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 2 }] })).json().result;
    const upi = (await pay("u1", { loc: "coffee", tender: "UPI", lines: [{ it: "chips", qty: 1 }] })).json().result;
    const staff = (await pay("u1", {
      loc: "coffee", tender: "Staff credit", payer: { kind: "staff", id: "RC-2088", name: "Suresh Muthu · Stores" },
      lines: [{ it: "bisc", qty: 1 }],
    })).json().result;

    const rep = (await xReport("u1")).json();
    const t = rep.totals;
    const line = (name: string) => t.tenders.find((x: { tender: string }) => x.tender === name);

    // Every tender gets a line, whether or not it took anything - Online too, which a QR order bills.
    expect(t.tenders.map((x: { tender: string }) => x.tender))
      .toEqual(["Cash", "UPI", "Card", "Staff credit", "Doctor credit", "Dept", "Online"]);
    expect(line("Cash")).toEqual({ tender: "Cash", amount: cash.tot, bills: 1 });
    expect(line("UPI")).toEqual({ tender: "UPI", amount: upi.tot, bills: 1 });
    expect(line("Staff credit")).toEqual({ tender: "Staff credit", amount: staff.tot, bills: 1 });
    expect(line("Card")).toEqual({ tender: "Card", amount: 0, bills: 0 });

    const sumOfTenders = t.tenders.reduce((a: number, x: { amount: number }) => a + x.amount, 0);
    expect(t.nettSales).toBe(sumOfTenders);
    expect(t.collected).toBe(cash.tot + upi.tot);
    expect(t.creditSales).toBe(staff.tot);
    expect(t.nettSales).toBe(t.collected + t.creditSales);
    expect(t.billCount).toBe(3);

    expect(t.taxTotal).toBe(Math.round((cash.tax + upi.tax + staff.tax) * 100) / 100);
    expect(t.sgst + t.cgst).toBe(t.taxTotal);
    expect(t.sgst).toBe(t.cgst);

    // Nobody was given a concession, so gross is nett.
    expect(t.discount).toBe(0);
    expect(t.grossSales).toBe(t.nettSales);

    // Every line the hospital's slip prints that this system has no figure for yet.
    expect([t.tip, t.parcelCharge, t.deliveryCharge, t.additionalCharge, t.complimentary, t.unCollected, t.unCollectedDiscount])
      .toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("a party discount shows as gross over nett, and nett is still what is owed", async () => {
    const doc = (await pay("u1", {
      loc: "coffee", tender: "Doctor credit", payer: { kind: "doctor", id: "DR-204", name: "Dr S. Menon · Paediatrics" },
      lines: [{ it: "water", qty: 5 }],
    })).json().result;
    expect(doc.disc).toBe(20);           // 20% off the consultants' rate card, on ₹100

    const t = (await xReport("u1")).json().totals;
    expect(t.nettSales).toBe(80);
    expect(t.discount).toBe(20);
    expect(t.grossSales).toBe(100);
    expect(t.creditSales).toBe(80);
    expect(t.collected).toBe(0);
  });

  it("a voided bill leaves the sales and shows on its own line", async () => {
    const keep = (await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] })).json().result;
    const gone = (await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "chips", qty: 2 }] })).json().result;
    const v = await voidBill("u2", gone.no, "Wrong tender");
    expect(v.statusCode, v.body).toBe(200);

    const t = (await xReport("u1")).json().totals;
    expect(t.nettSales).toBe(keep.tot);
    expect(t.billCount).toBe(1);
    expect(t.voidAmount).toBe(gone.tot);
    expect(t.voidBills).toBe(1);
  });

  it("money taken against an earlier bill is collection, not sale - it rides the Old Bills lines and never touches nett", async () => {
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    await given.settlement(app.db, { payer: { kind: "staff", id: "RC-2088", name: "Suresh Muthu · Stores" }, amount: 750, mode: "Bank transfer" });

    const t = (await xReport("u1")).json().totals;
    expect(t.oldBills.map((o: { mode: string }) => o.mode)).toEqual(["Cash", "UPI", "Card", "Bank transfer", "Payroll deduction"]);
    expect(t.oldBills.find((o: { mode: string }) => o.mode === "Bank transfer").amount).toBe(750);
    expect(t.oldBillsTotal).toBe(750);
    expect(t.nettSales).toBe(20);
    expect(t.collected).toBe(20);
  });

  it("a settlement taken before the session opened belongs to the Z before it, not this one", async () => {
    await given.settlement(app.db, {
      payer: { kind: "staff", id: "RC-2088", name: "Suresh Muthu · Stores" }, amount: 400,
      at: new Date(Date.now() - 3600_000),
    });
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });

    const t = (await xReport("u1")).json().totals;
    expect(t.oldBillsTotal).toBe(0);
  });
});

describe("a bill belongs to its Z, and a Z is final", () => {
  it("refuses a void once the bill's session has been closed off", async () => {
    const b = (await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] })).json().result;
    const z = (await close("u1", { loc: "coffee" })).json().result;

    const r = await voidBill("u2", b.no, "Wrong tender");
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error.message).toBe(`${b.no} was closed off on ${z.zNo} and can no longer be voided.`);

    // Nothing moved, and the Z still reads what it printed.
    const [row] = await app.db.select().from(s.bills).where(eq(s.bills.no, b.no));
    expect(row.voidedAt).toBeNull();
    expect((await zList("u1")).json()[0].totals.nettSales).toBe(20);
  });

  it("still allows the void while the session is open, on the same day", async () => {
    const b = (await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] })).json().result;
    const r = await voidBill("u2", b.no, "Wrong tender");
    expect(r.statusCode, r.body).toBe(200);
  });
});

describe("who may close which register", () => {
  it("a counter may not close another outlet's register", async () => {
    await pay("u6", { loc: "kiosk", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const r = await close("u1", { loc: "kiosk" });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error.message).toBe("You can only do this for your own counter.");
    expect((await openAt("kiosk")).length).toBe(1);
  });

  it("a counter may not read another outlet's X or Z list", async () => {
    expect((await xReport("u1", "kiosk")).statusCode).toBe(403);
    expect((await zList("u1", "?loc=kiosk")).statusCode).toBe(403);
  });

  it("the super admin may close any outlet's register by name, and signs the Z", async () => {
    await pay("u6", { loc: "kiosk", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const kiosk = await close("u7", { loc: "kiosk" });
    expect(kiosk.statusCode, kiosk.body).toBe(200);
    expect(kiosk.json().result.loc).toBe("kiosk");
    expect(kiosk.json().result.takenBy).toBe("System Administrator");
    expect((await close("u7", { loc: "coffee" })).statusCode).toBe(200);
    const list = await zList("u7", "?loc=kiosk");
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().map((z: { zNo: string }) => z.zNo)).toEqual([kiosk.json().result.zNo]);
    expect((await xReport("u7", "coffee")).statusCode).toBe(200);
  });

  it("the super admin has no till of its own, so it must name the outlet - a 400 otherwise", async () => {
    const sentence = "Choose the outlet whose register you want - the super admin has no counter of its own.";
    for (const r of [await xReport("u7"), await zList("u7")]) {
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.message).toBe(sentence);
    }
    const r = await app.inject({
      method: "POST", url: "/api/v1/register/close",
      headers: { ...(await authHeaders(app, "u7")), "idempotency-key": randomUUID() }, payload: { note: "" },
    });
    expect(r.statusCode, r.body).toBe(400);
  });

  it("the seeded counter and manager roles reach neither the Z list nor the close - the Z is nobody's by default", async () => {
    const plain = await hire("Plain Counter", "ROLE-001", "coffee");
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    for (const who of [plain, "u2"]) {
      expect((await zList(who)).statusCode, who).toBe(404);
      expect((await close(who, { loc: "coffee" })).statusCode, who).toBe(404);
      // The X is still theirs.
      expect((await xReport(who, "coffee")).statusCode, who).toBe(200);
    }
    expect((await openAt("coffee")).length).toBe(1);
  });

  it("the manager reads any outlet's X by name - the seeded role works for every outlet", async () => {
    await pay("u6", { loc: "kiosk", tender: "Cash", lines: [{ it: "water", qty: 1 }] });
    const r = await xReport("u2", "kiosk");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().totals.billCount).toBe(1);
  });

  it("a manager-desk role without every outlet is held to its own outlet's X", async () => {
    const role = await newRole("Restaurant Supervisor", "manager", { f: { x_report: "view" }, a: [] });
    const sup = await hire("Rest Supervisor", role, "rest");
    const own = await xReport(sup);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().loc).toBe("rest");
    const other = await xReport(sup, "kiosk");
    expect(other.statusCode, other.body).toBe(403);
    expect(other.json().error.message).toBe("You can only do this for your own counter.");
  });

  it("an outlet nobody opened is a 404, not a report of zeros", async () => {
    const r = await xReport("u2", "nosuchshop");
    expect(r.statusCode, r.body).toBe(404);
  });
});

describe("the open session is one row, whoever asks for it first", () => {
  it("two first sales in the same instant share one business day", async () => {
    // Without the pool warmed the second sale waits for a socket rather than for the index, and
    // begins only after the first has committed: the race never happens and this case passes
    // with the partial unique index dropped.
    await warmPool(app.testDb!, 2);
    const body: PayBody = { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] };
    const [a, b] = await Promise.all([pay("u1", body), pay("u1", body)]);
    expect([a.statusCode, b.statusCode], `${a.body} | ${b.body}`).toEqual([200, 200]);

    const rows = await sessionsAt("coffee");
    expect(rows.length).toBe(1);
    const bills = await app.db.select().from(s.bills).where(eq(s.bills.sessionId, rows[0].id));
    expect(bills.length).toBe(2);

    // And one Z accounts for both, which is what splitting the day in half would have cost.
    const z = (await close("u1", { loc: "coffee" })).json().result;
    expect(z.totals.billCount).toBe(2);
    expect(z.totals.nettSales).toBe(40);
  });

  it("a close and a sale in the same instant land on opposite sides of the Z, never on both", async () => {
    await warmPool(app.testDb!, 3);
    await pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] });

    const [shut, sold] = await Promise.all([
      close("u1", { loc: "coffee" }),
      pay("u1", { loc: "coffee", tender: "Cash", lines: [{ it: "chips", qty: 1 }] }),
    ]);
    expect(shut.statusCode, shut.body).toBe(200);
    expect(sold.statusCode, sold.body).toBe(200);

    const z = shut.json().result;
    const [late] = await app.db.select().from(s.bills).where(eq(s.bills.no, sold.json().result.no));
    // Either the sale got in before the count, or it opened the next day - never neither and
    // never both. The Z's own figures are the arbiter.
    const inside = late.sessionId === z.sessionId;
    expect(z.totals.nettSales).toBe(inside ? 40 : 20);
    expect(z.totals.billCount).toBe(inside ? 2 : 1);
    if (!inside) expect((await openAt("coffee")).length).toBe(1);
  });
});
