import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import type { Receivable, Settlement, Statement, Terms } from "@rch/contract";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { resetDocuments, truncateAll, warmPool } from "../../test/db.js";
import * as s from "../../db/schema/index.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => {
  app = await buildTestApp({ schema: "receivables" });
  await app.ready();
  await truncateAll(app.testDb!.db);
  await seedTestDb(app.testDb!.db);
});
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDocuments(app.testDb!.db); });

// u1 counter · u2 manager · u3 store · u4 kitchen · u5 buyer (the seeded accounts).
const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const write = async (method: "POST" | "PUT", user: string, url: string, payload?: object) => {
  const opts: InjectOptions = { method, url: `/api/v1${url}`, headers: await hdr(user) };
  if (payload !== undefined) opts.payload = payload;
  return app.inject(opts);
};
const get = async (user: string, url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: await authHeaders(app, user) });

const DOCTOR = { kind: "doctor" as const, id: "DR-204", name: "Dr S. Menon · Paediatrics" };
const EXCEPTION = { kind: "doctor" as const, id: "DR-118", name: "Dr A. Rao · Cardiology" };
const DEPT = { kind: "dept" as const, id: "CC-NUR", name: "Nursing" };

const owes = async (kind: string, id: string): Promise<number> => {
  const r = await get("u2", `/receivables/${kind}/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as Statement).outstanding;
};
const rows = async (): Promise<Receivable[]> => {
  const r = await get("u2", "/receivables");
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as Receivable[];
};
const rowFor = async (kind: string, id: string): Promise<Receivable> => {
  const found = (await rows()).find((x) => x.kind === kind && x.id === id);
  expect(found, `${kind}:${id} is not on the receivables list`).toBeDefined();
  return found!;
};

describe("the rate card", () => {
  it("opens with every category on it, so a sale always finds a rate to price against", async () => {
    const r = await get("u2", "/payer-terms");
    expect(r.statusCode, r.body).toBe(200);
    const t = r.json() as Terms;
    expect(t.classes.map((c) => c.cls)).toEqual(["customer", "patient", "staff", "dept", "doctor"]);
    // The demo hospital's own seed: consultants at 20%, staff with the ceiling this system has
    // always enforced, and nobody else given a concession the fixtures have no business inventing.
    expect(t.classes.find((c) => c.cls === "doctor")).toEqual({ cls: "doctor", pct: 20, limit: null });
    expect(t.classes.find((c) => c.cls === "staff")).toEqual({ cls: "staff", pct: 0, limit: 3000 });
    // And the one consultant on terms of their own.
    expect(t.payers).toEqual([{ kind: "doctor", id: "DR-118", name: EXCEPTION.name, pct: 25, limit: 5000 }]);
  });

  it("is read by the two roles that bill people and is empty for the three that do not", async () => {
    for (const who of ["u1", "u2"]) {
      const t = (await get(who, "/payer-terms")).json() as Terms;
      expect(t.classes.length, who).toBe(5);
    }
    // Not a 403: a manager's write announces "terms" to every open browser, and a route the
    // store keeper's tab is forbidden would fail that tab's whole refetch over a screen of
    // theirs that never changed. An empty card is the same shape, so nothing special-cases it.
    for (const who of ["u3", "u4", "u5"]) {
      const r = await get(who, "/payer-terms");
      expect(r.statusCode, who).toBe(200);
      expect(r.json() as Terms, who).toEqual({ classes: [], payers: [] });
    }
  });

  it("lets the manager move a category, and says what changed in the operator's words", async () => {
    const r = await write("PUT", "u2", "/payer-terms/class/dept", { pct: 80, limit: null });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result).toEqual({ cls: "dept", pct: 80, limit: null });
    expect(r.json().message).toBe("Every department now gets 80% off, with no credit limit");
    expect(r.json().changed).toEqual(["terms", "receivables"]);
  });

  it("refuses a rate that is not one, and writes nothing", async () => {
    const r = await write("PUT", "u2", "/payer-terms/class/doctor", { pct: 120, limit: null });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Refused - 120% is not a discount; give a rate between 0% and 100%");
    const [row] = await app.db.select().from(s.payerClassTerms).where(eq(s.payerClassTerms.cls, "doctor"));
    expect(row.discountPct).toBe(20);
  });

  it("refuses a negative ceiling, and takes zero as the real thing it is", async () => {
    const bad = await write("PUT", "u2", "/payer-terms/class/doctor", { pct: 20, limit: -1 });
    expect(bad.statusCode).toBe(422);
    // Zero is a category switched off for the month, which is a thing somebody means - and it is
    // emphatically not `null`, which is no ceiling at all.
    const ok = await write("PUT", "u2", "/payer-terms/class/doctor", { pct: 20, limit: 0 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().result.limit).toBe(0);
    // Put the seeded card back: the rate card is master data, so `resetDocuments` does not
    // restore it and every case after this one would price against a ceiling of zero.
    expect((await write("PUT", "u2", "/payer-terms/class/doctor", { pct: 20, limit: null })).statusCode).toBe(200);
  });

  it("gives one person terms of their own, and takes the exception away again", async () => {
    const set = await write("PUT", "u2", `/payer-terms/doctor/${DOCTOR.id}`, { pct: 40, limit: 1000 });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json().message).toBe(`${DOCTOR.name} now gets 40% off, with a ₹1,000.00 credit limit`);

    // Both fields back to "inherit" removes the row rather than keeping two nulls, so the
    // manager's list of exceptions is the exceptions and nothing else.
    const clear = await write("PUT", "u2", `/payer-terms/doctor/${DOCTOR.id}`, { pct: null, limit: null });
    expect(clear.statusCode, clear.body).toBe(200);
    expect(clear.json().message).toBe(`${DOCTOR.name} is back on the doctor rate - 20% off, with no credit limit`);
    const left = await app.db.select().from(s.payerTerms).where(and(eq(s.payerTerms.kind, "doctor"), eq(s.payerTerms.payerId, DOCTOR.id)));
    expect(left).toEqual([]);
  });

  it("is a 404 for a payer who is not on the register", async () => {
    const r = await write("PUT", "u2", "/payer-terms/doctor/DR-000", { pct: 10, limit: null });
    expect(r.statusCode).toBe(404);
  });

  it("is closed to every role but the manager", async () => {
    for (const who of ["u1", "u3", "u4", "u5"]) {
      const r = await write("PUT", who, "/payer-terms/class/doctor", { pct: 5, limit: null });
      expect(r.statusCode, who).toBe(404);
    }
  });
});

describe("what the till charges a party", () => {
  const sell = async (payer: typeof DOCTOR, tender = "Doctor credit") => app.inject({
    method: "POST", url: "/api/v1/bills", headers: await hdr("u1"),
    payload: { loc: "coffee", tender, payer, lines: [{ it: "water", qty: 1 }] },   // water is ₹20 on list B
  });

  it("takes the category's rate off, and leaves the printed price on the line", async () => {
    const r = await sell(DOCTOR);
    expect(r.statusCode, r.body).toBe(200);
    const bill = r.json().result;
    expect(bill.tot).toBe(16);      // ₹20 less the doctors' 20%
    expect(bill.disc).toBe(4);
    expect(bill.discPct).toBe(20);
    // What the product costs stays on the line; what this person paid is the head.
    expect(bill.lines).toEqual([{ it: "water", qty: 1, rate: 20 }]);
    expect(r.json().message).toContain("20% doctor discount, ₹4.00 off");
  });

  it("gives a person their own rate over their category's", async () => {
    const r = await sell(EXCEPTION);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.tot).toBe(15);     // ₹20 less DR-118's own 25%
    expect(r.json().result.discPct).toBe(25);
  });

  it("charges a walk-in the shelf price, and says nothing about a discount", async () => {
    const r = await app.inject({
      method: "POST", url: "/api/v1/bills", headers: await hdr("u1"),
      payload: { loc: "coffee", tender: "Cash", lines: [{ it: "water", qty: 1 }] },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.tot).toBe(20);
    // `strip` drops both keys at zero, so a bill nobody discounted is the bill it always was.
    expect(r.json().result.disc).toBeUndefined();
    expect(r.json().result.discPct).toBeUndefined();
    expect(r.json().message).not.toContain("discount");
  });

  it("prices against the rate the manager has set, not the one the bill was built with", async () => {
    await write("PUT", "u2", "/payer-terms/class/doctor", { pct: 50, limit: null });
    const r = await sell(DOCTOR);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.tot).toBe(10);
    expect((await write("PUT", "u2", "/payer-terms/class/doctor", { pct: 20, limit: null })).statusCode).toBe(200);
  });

  it("charges what the bill totals to the account, discount and all", async () => {
    await sell(DOCTOR);
    expect(await owes("doctor", DOCTOR.id)).toBe(16);
  });
});

describe("settling what is owed", () => {
  const charge = async (payer: typeof DOCTOR, total: number, at?: Date) =>
    given.bill(app.db, { loc: "coffee", tender: "Doctor credit", payer, total, at, lines: [{ it: "water", qty: 1, rate: total }] });

  it("closes the oldest bills first and stores what it closed", async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000);
    const first = await charge(DOCTOR, 100, day(3));
    const second = await charge(DOCTOR, 100, day(2));
    const third = await charge(DOCTOR, 100, day(1));

    const r = await write("POST", "u2", "/settlements", { kind: "doctor", id: DOCTOR.id, amount: 250, mode: "UPI", note: "September" });
    expect(r.statusCode, r.body).toBe(200);
    const stl = r.json().result as Settlement;
    expect(stl.lines).toEqual([{ no: first, amount: 100 }, { no: second, amount: 100 }, { no: third, amount: 50 }]);
    expect(stl.amount).toBe(250);
    expect(stl.payer).toEqual(DOCTOR);
    expect(r.json().message).toBe(`${stl.id} · ₹250.00 from ${DOCTOR.name} against 3 bills - ₹50.00 still owed`);
    expect(await owes("doctor", DOCTOR.id)).toBe(50);

    // And the statement reads the part payment back as the part that is left.
    const st = (await get("u2", `/receivables/doctor/${DOCTOR.id}`)).json() as Statement;
    expect(st.open).toEqual([{ no: third, loc: "coffee", at: expect.any(String), total: 100, settled: 50, owed: 50 }]);
  });

  it("says the account is clear when it is", async () => {
    await charge(DOCTOR, 80);
    const r = await write("POST", "u2", "/settlements", { kind: "doctor", id: DOCTOR.id, amount: 80, mode: "Cash" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().message).toBe(`${r.json().result.id} · ₹80.00 from ${DOCTOR.name} - the account is clear`);
    expect(await owes("doctor", DOCTOR.id)).toBe(0);
  });

  it("refuses more than is owed, names the balance, and writes nothing", async () => {
    await charge(DOCTOR, 320);
    const before = (await app.db.select().from(s.settlements)).length;
    const r = await write("POST", "u2", "/settlements", { kind: "doctor", id: DOCTOR.id, amount: 450, mode: "Cash" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`Refused - ₹450.00 is more than the ₹320.00 ${DOCTOR.name} still owes`);
    expect((await app.db.select().from(s.settlements)).length).toBe(before);
    expect(await owes("doctor", DOCTOR.id)).toBe(320);
  });

  it("refuses a payment against an account that owes nothing", async () => {
    const r = await write("POST", "u2", "/settlements", { kind: "dept", id: DEPT.id, amount: 100, mode: "Cash" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`Refused - ${DEPT.name} owes nothing`);
  });

  it("counts only what an account tender created", async () => {
    // A bill the same person paid cash for in their own name is not a debt.
    await given.bill(app.db, { loc: "coffee", tender: "Cash", payer: DOCTOR, total: 500, lines: [{ it: "water", qty: 1, rate: 500 }] });
    expect(await owes("doctor", DOCTOR.id)).toBe(0);
  });

  it("is a 404 for a payer who is not on the register", async () => {
    const r = await write("POST", "u2", "/settlements", { kind: "doctor", id: "DR-000", amount: 10, mode: "Cash" });
    expect(r.statusCode).toBe(404);
  });

  it("is closed to every role but the manager", async () => {
    await charge(DOCTOR, 50);
    for (const who of ["u1", "u3", "u4", "u5"]) {
      const r = await write("POST", who, "/settlements", { kind: "doctor", id: DOCTOR.id, amount: 10, mode: "Cash" });
      expect(r.statusCode, who).toBe(404);
    }
  });
});

describe("taking a payment back", () => {
  const charge = async (total: number) =>
    given.bill(app.db, { loc: "coffee", tender: "Doctor credit", payer: DOCTOR, total, lines: [{ it: "water", qty: 1, rate: total }] });
  const settle = async (amount: number) => {
    const r = await write("POST", "u2", "/settlements", { kind: "doctor", id: DOCTOR.id, amount, mode: "Cash" });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().result.id as string;
  };

  it("reopens the bills it closed and brings the balance back", async () => {
    const bill = await charge(200);
    const id = await settle(200);
    expect(await owes("doctor", DOCTOR.id)).toBe(0);

    const v = await write("POST", "u2", `/settlements/${id}/void`, { reason: "Keyed against the wrong consultant" });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().result.voided).toBe(true);
    expect(v.json().message).toBe(`${id} voided - ${DOCTOR.name} owes ₹200.00 again`);
    expect(await owes("doctor", DOCTOR.id)).toBe(200);

    // Badged, never erased: the row and its allocation both stay exactly as they were recorded.
    const st = (await get("u2", `/receivables/doctor/${DOCTOR.id}`)).json() as Statement;
    const voided = st.settlements.find((x) => x.id === id);
    expect(voided?.lines).toEqual([{ no: bill, amount: 200 }]);
    expect(voided?.voidReason).toBe("Keyed against the wrong consultant");
  });

  it("needs a reason, and refuses a second void", async () => {
    await charge(60);
    const id = await settle(60);
    const blank = await write("POST", "u2", `/settlements/${id}/void`, { reason: "   " });
    expect(blank.statusCode).toBe(422);
    expect(blank.json().error.message).toBe("Give a reason for voiding this settlement");

    expect((await write("POST", "u2", `/settlements/${id}/void`, { reason: "first" })).statusCode).toBe(200);
    const again = await write("POST", "u2", `/settlements/${id}/void`, { reason: "second" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe(`${id} has already been voided`);
  });

  it("is refused after the hospital day it was taken on", async () => {
    const bill = await charge(90);
    // Written straight in, dated yesterday: the route's own guard is what is being pinned, and
    // there is no door that records a settlement in the past.
    const id = await given.settlement(app.db, {
      kind: "doctor", id: DOCTOR.id, name: DOCTOR.name, amount: 90,
      at: new Date(Date.now() - 36 * 60 * 60 * 1000), lines: [{ no: bill, amount: 90 }],
    });
    const r = await write("POST", "u2", `/settlements/${id}/void`, { reason: "Too late" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toContain("record a correcting payment instead");
    expect(await owes("doctor", DOCTOR.id)).toBe(0);
  });

  it("stops a bill a live settlement has closed from being voided, and names the settlement", async () => {
    const bill = await charge(120);
    const id = await settle(120);
    const r = await write("POST", "u2", `/bills/${encodeURIComponent(bill)}/void`, { reason: "Mis-keyed" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${bill} has been settled by ${id} - void that settlement first, then this bill`);

    // Void the payment and the bill is voidable again, which is what the refusal told them to do.
    expect((await write("POST", "u2", `/settlements/${id}/void`, { reason: "Undoing the mis-key" })).statusCode).toBe(200);
    expect((await write("POST", "u2", `/bills/${encodeURIComponent(bill)}/void`, { reason: "Mis-keyed" })).statusCode).toBe(200);
  });
});

describe("who owes what", () => {
  it("lists every party with what they owe and what they are on", async () => {
    await given.bill(app.db, { loc: "coffee", tender: "Doctor credit", payer: DOCTOR, total: 240, lines: [{ it: "water", qty: 1, rate: 240 }] });
    const row = await rowFor("doctor", DOCTOR.id);
    expect(row).toMatchObject({
      name: DOCTOR.name, active: true, charged: 240, settled: 0, outstanding: 240, bills: 1, pct: 20, limit: null,
    });
    expect(row.oldest).toEqual(expect.any(String));
  });

  it("keeps a party who owes nothing, because that is half of what the screen is for", async () => {
    const row = await rowFor("dept", DEPT.id);
    expect(row.outstanding).toBe(0);
    expect(row.bills).toBe(0);
    expect(row.oldest).toBeUndefined();
  });

  it("sorts what is owed to the top", async () => {
    await given.bill(app.db, { loc: "coffee", tender: "Doctor credit", payer: DOCTOR, total: 10, lines: [{ it: "water", qty: 1, rate: 10 }] });
    await given.bill(app.db, { loc: "coffee", tender: "Doctor credit", payer: EXCEPTION, total: 900, lines: [{ it: "water", qty: 1, rate: 900 }] });
    const all = await rows();
    expect(all[0].id).toBe(EXCEPTION.id);
    expect(all[1].id).toBe(DOCTOR.id);
  });

  it("is empty for every role but the manager, and never a 403", async () => {
    for (const who of ["u1", "u3", "u4", "u5"]) {
      const r = await get(who, "/receivables");
      expect(r.statusCode, who).toBe(200);
      expect(r.json(), who).toEqual([]);
      const f = await get(who, "/settlements");
      expect(f.statusCode, who).toBe(200);
      expect(f.json(), who).toEqual([]);
    }
    // The statement is opened by hand from a drawer and is never in a `changed`, so it can stay
    // closed outright.
    expect((await get("u1", `/receivables/doctor/${DOCTOR.id}`)).statusCode).toBe(404);
  });
});

describe("a payment and a sale cannot both spend the same room", () => {
  it("serialises them per payer, so a settlement never allocates a bill twice", async () => {
    // Two payments of ₹150 against a ₹200 balance: either alone fits and both together do not.
    // The balance is a sum over rows that are already committed, so without `lockPayerCredit`
    // both reads see ₹200 owed before either has written, both pass, and the hospital has
    // recorded ₹300 against a ₹200 debt. Proven by commenting the advisory lock out: both 200.
    await app.db.insert(s.payers).values({ kind: "doctor", id: "DR-909", name: "Dr V. Suresh · Neurology" });
    const payer = { kind: "doctor" as const, id: "DR-909", name: "Dr V. Suresh · Neurology" };
    await given.bill(app.db, { loc: "coffee", tender: "Doctor credit", payer, total: 200, lines: [{ it: "water", qty: 1, rate: 200 }] });
    await warmPool(app.testDb!, 2);
    const body = { kind: "doctor", id: "DR-909", amount: 150, mode: "Cash" };

    const [a, b] = await Promise.all([write("POST", "u2", "/settlements", body), write("POST", "u2", "/settlements", body)]);

    expect([a.statusCode, b.statusCode].sort(), `${a.body} | ${b.body}`).toEqual([200, 422]);
    expect(await owes("doctor", "DR-909")).toBe(50);
    const live = await app.db.select().from(s.settlements).where(eq(s.settlements.payerId, "DR-909"));
    expect(live.length).toBe(1);
  });
});
