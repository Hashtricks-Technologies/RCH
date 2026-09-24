import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { CurrentShiftResponseSchema, ShiftReportSchema, ShiftReportsResponseSchema, type ShiftReport } from "@rch/contract";
import * as s from "../../db/schema/index.js";
import { buildTestApp } from "../../test/app.js";
import { given } from "../../test/builders.js";
import { giveRole, seededPlus } from "../../test/roles.js";
import { resetDocuments, warmPool } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "shifts", env: { LOGIN_RATE_LIMIT_PER_MINUTE: "200" } }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDocuments(app.db); });

// u1 Kavitha Raman, RC-4471, counter, posted to coffee and kiosk · u6 Deepa Selvam, RC-4482,
// counter at the kiosk · u2 manager · u3 store keeper.
const SH = /^SH-\d{4}-\d{4}$/;

const signIn = async (emp: string, loc?: string) => {
  const r = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { emp, password: "changeme", ...(loc ? { loc } : {}) } });
  expect(r.statusCode, r.body).toBe(200);
  const cookie = r.cookies.find((c) => c.name === "rch_refresh")?.value ?? "";
  return { authorization: `Bearer ${r.json().accessToken as string}`, cookie };
};
const current = async (h: { authorization: string }) => {
  const r = await app.inject({ method: "GET", url: "/api/v1/shifts/current", headers: { authorization: h.authorization } });
  expect(r.statusCode, r.body).toBe(200);
  expect(CurrentShiftResponseSchema.safeParse(r.json()).success, r.body).toBe(true);
  return r.json().shift as ShiftReport | null;
};
const close = async (h: { authorization: string }) =>
  app.inject({ method: "POST", url: "/api/v1/shifts/close", headers: { authorization: h.authorization, "idempotency-key": randomUUID() } });
const list = async (h: { authorization: string }, q = "") => {
  const r = await app.inject({ method: "GET", url: `/api/v1/shifts${q}`, headers: { authorization: h.authorization } });
  expect(r.statusCode, r.body).toBe(200);
  expect(ShiftReportsResponseSchema.safeParse(r.json()).success, r.body).toBe(true);
  return r.json() as ShiftReport[];
};
const openOf = async (userId: string) =>
  app.db.select().from(s.shifts).where(and(eq(s.shifts.userId, userId), isNull(s.shifts.closedAt)));
const allOf = async (userId: string) => app.db.select().from(s.shifts).where(eq(s.shifts.userId, userId));

describe("a shift starts with the sign-in at a counter", () => {
  it("opens a numbered shift at the counter the session stands at", async () => {
    await signIn("RC-4471");
    const open = await openOf("u1");
    expect(open).toHaveLength(1);
    expect(open[0].id).toMatch(SH);
    expect(open[0].loc).toBe("coffee");
  });

  it("keeps the open shift when the same person signs in again at the same counter", async () => {
    await signIn("RC-4471");
    const [first] = await openOf("u1");
    await signIn("RC-4471", "coffee");
    expect(await allOf("u1")).toEqual([first]);
  });

  it("closes the one left open at another counter, marked automatic with its figures stored, and opens a new one here", async () => {
    await signIn("RC-4471");
    const [coffee] = await openOf("u1");
    await given.bill(app.db, { loc: "coffee", operator: "u1", total: 120, tender: "Cash" });

    await signIn("RC-4471", "kiosk");
    const [kiosk] = await openOf("u1");
    expect(kiosk.loc).toBe("kiosk");
    expect(kiosk.id).not.toBe(coffee.id);
    expect(Number(kiosk.id.slice(-4))).toBe(Number(coffee.id.slice(-4)) + 1);

    const [was] = await app.db.select().from(s.shifts).where(eq(s.shifts.id, coffee.id));
    expect(was.closedAt).not.toBeNull();
    expect(was.closedTotals).toMatchObject({ auto: true, nettSales: 120, billCount: 1 });

    const rows = await list(await authHeaders(app, "u2"));
    expect(rows.map((r) => [r.id, r.auto, r.totals.nettSales])).toEqual([[coffee.id, true, 120]]);
  });

  it("opens nothing for a desk that is not a counter", async () => {
    await signIn("RC-3120");
    await signIn("RC-2088");
    expect(await app.db.select().from(s.shifts)).toEqual([]);
  });

  it("is not opened by a refresh", async () => {
    const h = await signIn("RC-4471");
    expect((await close(h)).statusCode).toBe(200);
    const r = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", cookies: { rch_refresh: h.cookie } });
    expect(r.statusCode, r.body).toBe(200);
    expect(await openOf("u1")).toEqual([]);
  });

  it("two sign-ins racing each other open one shift between them, not a 500", async () => {
    await warmPool(app.testDb!, 2);
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { emp: "RC-4482", password: "changeme" } }),
      app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { emp: "RC-4482", password: "changeme" } }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(await allOf("u6")).toHaveLength(1);
  });
});

describe("the live report is this operator's own bills at this counter since the shift opened", () => {
  it("counts per tender, leaves out other people, other counters and earlier bills, and puts voids on their own line", async () => {
    await given.bill(app.db, { loc: "coffee", operator: "u1", total: 999, tender: "Cash", at: new Date(Date.now() - 3600_000) });
    const h = await signIn("RC-4471");
    await given.bill(app.db, { loc: "coffee", operator: "u1", total: 100, tax: 5, tender: "Cash" });
    await given.bill(app.db, { loc: "coffee", operator: "u1", total: 50, tax: 2.5, tender: "UPI" });
    const doc = await given.bill(app.db, { loc: "coffee", operator: "u1", total: 80, tender: "Doctor credit", payer: { kind: "doctor", id: "DR-204", name: "Dr S. Menon · Paediatrics" } });
    await app.db.update(s.bills).set({ discount: 20, discountPct: 20 }).where(eq(s.bills.no, doc));
    const gone = await given.bill(app.db, { loc: "coffee", operator: "u1", total: 30, tender: "Cash" });
    await app.db.update(s.bills).set({ voidedAt: new Date(), voidedBy: "u2", voidReason: "Wrong tender" }).where(eq(s.bills.no, gone));
    await given.bill(app.db, { loc: "coffee", operator: "u6", total: 400, tender: "Cash" });
    await given.bill(app.db, { loc: "kiosk", operator: "u1", total: 400, tender: "Cash" });

    const r = (await current(h))!;
    expect(r.closedAt).toBeNull();
    expect(r.operator).toBe("Kavitha Raman");
    expect(r.loc).toBe("coffee");
    const t = r.totals;
    expect(t.tenders.slice(0, 3)).toEqual([
      { tender: "Cash", amount: 100, bills: 1 },
      { tender: "UPI", amount: 50, bills: 1 },
      { tender: "Card", amount: 0, bills: 0 },
    ]);
    expect(t.tenders.find((x) => x.tender === "Doctor credit")).toEqual({ tender: "Doctor credit", amount: 80, bills: 1 });
    expect(t.billCount).toBe(3);
    expect(t.nettSales).toBe(230);
    expect(t.discount).toBe(20);
    expect(t.grossSales).toBe(250);
    expect(t.collected).toBe(150);
    expect(t.creditSales).toBe(80);
    expect(t.taxTotal).toBe(7.5);
    expect([t.voidBills, t.voidAmount]).toEqual([1, 30]);
  });

  it("answers no shift for a session with none open at its counter", async () => {
    expect(await current(await authHeaders(app, "u1"))).toBeNull();
    // Open at the kiosk; a session standing at the coffee shop does not read it as its own.
    await signIn("RC-4471", "kiosk");
    expect(await current(await authHeaders(app, "u1"))).toBeNull();
  });

  it("is the counter's alone", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/shifts/current", headers: await authHeaders(app, "u2") });
    expect(r.statusCode).toBe(404);
  });
});

describe("Close Shift", () => {
  it("stores the figures, closes the shift, says so, and announces shifts", async () => {
    const h = await signIn("RC-4471");
    const [open] = await openOf("u1");
    await given.bill(app.db, { loc: "coffee", operator: "u1", total: 100, tender: "Cash" });
    await given.bill(app.db, { loc: "coffee", operator: "u1", total: 60, tender: "Card" });

    const r = await close(h);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(ShiftReportSchema.safeParse(body.result).success, r.body).toBe(true);
    expect(body.changed).toEqual(["shifts"]);
    expect(body.result).toMatchObject({ id: open.id, loc: "coffee", auto: false, operator: "Kavitha Raman" });
    expect(body.result.closedAt).toBe(body.result.takenAt);
    expect(body.message).toBe(`${open.id} closed your shift at Coffee Shop - ₹160.00 over 2 bills. Sign in again to start the next one.`);

    const [row] = await app.db.select().from(s.shifts).where(eq(s.shifts.id, open.id));
    expect(row.closedAt).not.toBeNull();
    expect(row.closedTotals).toMatchObject({ auto: false, nettSales: 160, billCount: 2 });
    expect(await current(h)).toBeNull();
  });

  it("refuses when nothing is open, and when the open shift is at another counter", async () => {
    const none = await close(await authHeaders(app, "u1"));
    expect(none.statusCode).toBe(422);
    expect(none.json().error.message).toBe("Refused - you have no open shift to close; sign in again at your counter to start one.");

    await signIn("RC-4471", "kiosk");
    const elsewhere = await close(await authHeaders(app, "u1"));
    expect(elsewhere.statusCode).toBe(422);
    expect(elsewhere.json().error.message).toBe("Refused - your open shift is at Snack Kiosk, not Coffee Shop; close it there, or sign in here to start one.");
    expect(await openOf("u1")).toHaveLength(1);
  });

  it("reads back what it stored, not a sum over the bills again", async () => {
    const h = await signIn("RC-4471");
    await given.bill(app.db, { loc: "coffee", operator: "u1", total: 100, tender: "Cash" });
    const closed = (await close(h)).json().result as ShiftReport;
    // A bill inside the closed window, added behind the close's back.
    await given.bill(app.db, { loc: "coffee", operator: "u1", total: 5000, tender: "Cash", at: new Date(closed.openedAt) });
    const [row] = await list(await authHeaders(app, "u2"));
    expect(row.totals.nettSales).toBe(100);
  });
});

describe("the list of closed shifts", () => {
  const shiftAt = async (emp: string, loc?: string) => {
    const h = await signIn(emp, loc);
    return (await close(h)).json().result as ShiftReport;
  };

  it("is every outlet's for the manager, narrowed by outlet on request, and only their own for a counter", async () => {
    const coffee = await shiftAt("RC-4471");
    const kiosk = await shiftAt("RC-4482");
    const mgr = await authHeaders(app, "u2");
    expect((await list(mgr)).map((r) => r.id)).toEqual([kiosk.id, coffee.id]);
    expect((await list(mgr, "?loc=kiosk")).map((r) => r.id)).toEqual([kiosk.id]);
    expect((await list(await authHeaders(app, "u1"))).map((r) => r.id)).toEqual([coffee.id]);
    expect((await list(await authHeaders(app, "u6"))).map((r) => r.id)).toEqual([kiosk.id]);
  });

  it("is every outlet's for a counter role given Shift reports, and nobody's for a manager role without it", async () => {
    const coffee = await shiftAt("RC-4471");
    const kiosk = await shiftAt("RC-4482");
    let undo = await giveRole(app, "u1", "counter", seededPlus("counter", { shift_reports: "view" }));
    try {
      expect((await list(await authHeaders(app, "u1"))).map((r) => r.id)).toEqual([kiosk.id, coffee.id]);
      expect((await list(await authHeaders(app, "u1"), "?loc=kiosk")).map((r) => r.id)).toEqual([kiosk.id]);
    } finally { await undo(); }
    undo = await giveRole(app, "u2", "manager", { f: { prices: "edit" }, a: [] });
    try {
      expect(await list(await authHeaders(app, "u2"))).toEqual([]);
    } finally { await undo(); }
  });

  it("answers an empty list to a desk that takes no shifts, so a close never fails its refetch", async () => {
    await shiftAt("RC-4471");
    expect(await list(await authHeaders(app, "u3"))).toEqual([]);
  });

  it("leaves out a shift closed before the window", async () => {
    const old = await shiftAt("RC-4471");
    await app.db.update(s.shifts).set({ closedAt: new Date(Date.now() - 10 * 86_400_000) }).where(eq(s.shifts.id, old.id));
    expect(await list(await authHeaders(app, "u2"))).toEqual([]);
    expect((await list(await authHeaders(app, "u2"), "?days=30")).map((r) => r.id)).toEqual([old.id]);
  });
});
