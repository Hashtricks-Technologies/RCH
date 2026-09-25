import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { items } from "../../db/schema/index.js";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { warmPool } from "../../test/db.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "requisitions" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (u: string, url: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, headers: await hdr(u), payload });
/** The requisition desk, off `GET /snapshot` - `GET /requisitions` is Task 4's and lands in
 *  this same wave, so nothing here may depend on it. */
const list = async (u = "u5") => (await app.inject({ method: "GET", url: "/api/v1/snapshot", headers: await authHeaders(app, u) })).json().prq;
const one = async (id: string) => (await list()).find((p: { id: string }) => p.id === id);

describe("POST /requisitions", () => {
  it("sends the store keeper's ask to procurement and signs it", async () => {
    const r = await post("u3", "/requisitions", { lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }], note: "Weekly dairy" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result).toMatchObject({ st: "Sent", note: "Weekly dairy", by: "Suresh Muthu" });
    expect(b.result.id).toMatch(/^PRQ-\d{4}-0\d+$/);
    expect(b.result.lines).toEqual([
      { it: "milk", qty: 60, appr: 0, ordered: 0 },
      { it: "butter", qty: 6, appr: 0, ordered: 0 },
    ]);
    expect(b.result.hist.at(-1)).toMatchObject({ s: "Sent", who: "Suresh Muthu" });
    expect(b.changed).toEqual(["prq"]);
    expect(b.message).toBe(`${b.result.id} sent to procurement`);
  });

  it("refuses an empty ask, and one with a zero on it", async () => {
    expect((await post("u3", "/requisitions", { lines: [{ it: "milk", qty: 0 }] })).json().error.message)
      .toBe("Add at least one line before sending");
    expect((await post("u3", "/requisitions", { lines: [] })).statusCode).toBe(400);   // the schema's own floor
  });

  it("refuses the same item twice rather than deciding it twice", async () => {
    const r = await post("u3", "/requisitions", { lines: [{ it: "milk", qty: 20 }, { it: "milk", qty: 40 }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Combine the Milk 1L (toned) lines into one");
  });

  it("404s an unknown item, and is absent for every other role", async () => {
    expect((await post("u3", "/requisitions", { lines: [{ it: "totally-fake", qty: 1 }] })).json().error.message)
      .toBe("There is no item totally-fake.");
    for (const u of ["u1", "u2", "u4", "u5"]) {
      expect((await post(u, "/requisitions", { lines: [{ it: "milk", qty: 1 }] })).statusCode).toBe(404);
    }
  });

  it("refuses a retired item by name, on the ask and on the buyer's direct add alike", async () => {
    await app.db.update(items).set({ active: false }).where(eq(items.key, "butter"));
    try {
      for (const [u, url, extra] of [["u3", "/requisitions", {}], ["u5", "/requisitions/direct", { note: "Festival week" }]] as const) {
        const r = await post(u, url, { lines: [{ it: "milk", qty: 1 }, { it: "butter", qty: 1 }], ...extra });
        expect(r.statusCode).toBe(422);
        expect(r.json().error.message).toBe("Refused - Butter, salted is retired and is no longer bought");
      }
    } finally {
      await app.db.update(items).set({ active: true }).where(eq(items.key, "butter"));
    }
  });
});

describe("POST /requisitions/direct", () => {
  const REASON = "Festival week - the store keeper is on leave";

  it("puts the buyer's own items straight on the procurement list, approved in full and signed", async () => {
    const r = await post("u5", "/requisitions/direct", { lines: [{ it: "cup", qty: 500 }, { it: "juice", qty: 48.0004 }], note: REASON });
    expect(r.statusCode, r.body).toBe(400);   // a fourth decimal is the schema's to refuse, as everywhere

    const b = (await post("u5", "/requisitions/direct", { lines: [{ it: "cup", qty: 500 }, { it: "juice", qty: 48 }], note: REASON })).json();
    expect(b.result).toMatchObject({ st: "Approved", by: "Latha Narayanan", apprBy: "Latha Narayanan", note: REASON, apprNote: REASON });
    expect(b.result.id).toMatch(/^PRQ-\d{4}-\d+$/);
    expect(b.result.lines).toEqual([
      { it: "cup", qty: 500, appr: 500, ordered: 0, short: 0 },
      { it: "juice", qty: 48, appr: 48, ordered: 0, short: 0 },
    ]);
    // Nobody sent it, so the trail is the one decision and not a Sent row the buyer never made.
    expect(b.result.hist.map((h: { s: string; who: string }) => [h.s, h.who])).toEqual([["Approved", "Latha Narayanan"]]);
    expect(b.changed).toEqual(["prq"]);
    expect(b.message).toBe(`${b.result.id} added to the procurement list - 2 line(s)`);
    expect((await one(b.result.id)).st).toBe("Approved");
  });

  it("is a requisition a purchase order can claim against like any other", async () => {
    const prq = (await post("u5", "/requisitions/direct", { lines: [{ it: "box", qty: 200 }], note: REASON })).json().result.id;
    const po = await post("u5", "/purchase-orders", { vendorId: "VN-002", picks: [{ prq, line: 0, qty: 150 }] });
    expect(po.statusCode, po.body).toBe(200);
    expect((await one(prq)).lines[0]).toMatchObject({ appr: 200, ordered: 150 });
  });

  it("wants a reason, a quantity on every line and one line per item", async () => {
    const refused = async (payload: Record<string, unknown>) => {
      const r = await post("u5", "/requisitions/direct", payload);
      expect(r.statusCode, r.body).toBe(422);
      return r.json().error.message;
    };
    expect(await refused({ lines: [{ it: "cup", qty: 10 }], note: "   " }))
      .toBe("Give a reason - it is kept on the requisition for the store keeper");
    expect(await refused({ lines: [{ it: "cup", qty: 10 }, { it: "box", qty: 0 }], note: REASON }))
      .toBe("Enter a quantity on every line");
    expect(await refused({ lines: [{ it: "milk", qty: 10 }, { it: "milk", qty: 5 }], note: REASON }))
      .toBe("Combine the Milk 1L (toned) lines into one");
    expect((await post("u5", "/requisitions/direct", { lines: [{ it: "cup", qty: 10 }] })).statusCode).toBe(400);
  });

  it("never buys what the kitchen makes or the counter assembles", async () => {
    for (const [it, n] of [["puff", "Veg puffs"], ["capp", "Cappuccino"]]) {
      const r = await post("u5", "/requisitions/direct", { lines: [{ it: "cup", qty: 10 }, { it, qty: 10 }], note: REASON });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.message).toBe(`${n} is made in-house - only raw, packing and MRP goods are bought`);
    }
  });

  it("404s an unknown item, and is absent for every other role", async () => {
    expect((await post("u5", "/requisitions/direct", { lines: [{ it: "totally-fake", qty: 1 }], note: REASON })).json().error.message)
      .toBe("There is no item totally-fake.");
    for (const u of ["u1", "u2", "u3", "u4"]) {
      expect((await post(u, "/requisitions/direct", { lines: [{ it: "cup", qty: 1 }], note: REASON })).statusCode).toBe(404);
    }
  });
});

describe("POST /requisitions/:id/approve", () => {
  it("approves every line in full and puts them on the procurement list", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }] });
    const r = await post("u5", `/requisitions/${id}/approve`, { appr: [60, 6], note: "Approved in full." });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.st).toBe("Approved");
    expect(b.result.lines.map((l: { appr: number; ordered: number }) => [l.appr, l.ordered])).toEqual([[60, 0], [6, 0]]);
    expect(b.result.apprBy).toBe("Latha Narayanan");
    expect(b.message).toBe(`${id} approved - 2 line(s) on the procurement list`);
  });

  it("never approves more than was asked, and records the shortfall", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }] });
    const b = (await post("u5", `/requisitions/${id}/approve`, { appr: [999, 4], note: "" })).json();
    expect(b.result.st).toBe("Partially approved");
    expect(b.result.lines[0]).toMatchObject({ appr: 60, short: 0 });
    expect(b.result.lines[1]).toMatchObject({ appr: 4, short: 2 });
    expect(b.message).toBe(`${id} partially approved - 2 line(s) on the procurement list`);
  });

  it("leaves a claim a live order already holds exactly where it is", async () => {
    // A requisition can be re-decided only once, so this is about the write, not a second pass:
    // approving must not touch ordered_qty, or a claimed quantity would reappear on the list.
    //
    // The line carries an approval as well as the claim, because a claim is only ever drawn
    // against an approved quantity (`procurementList` is approved less ordered) and
    // `requisition_lines_ordered_ck` now says so at the database: a row claimed for 25 against
    // an approval of nothing is a state no buyer could have produced.
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60, appr: 60, ordered: 25 }] });
    const b = (await post("u5", `/requisitions/${id}/approve`, { appr: [60], note: "" })).json();
    expect(b.result.lines[0]).toMatchObject({ appr: 60, ordered: 25 });
  });

  it("treats an all-zero approval as a decline, and wants a reason for it", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }] });
    const bare = await post("u5", `/requisitions/${id}/approve`, { appr: [0], note: "  " });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().error.message).toBe("Give a reason - the store keeper sees it on the requisition");
    expect((await one(id)).st).toBe("Sent");

    const b = (await post("u5", `/requisitions/${id}/approve`, { appr: [0], note: "Vendor cannot supply" })).json();
    expect(b.result.st).toBe("Declined");
    expect(b.result.lines[0]).toMatchObject({ appr: 0, short: 60 });
    expect(b.message).toBe(`${id} declined - nothing goes on the procurement list`);
  });

  it("refuses a decision that does not cover every line", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }] });
    const r = await post("u5", `/requisitions/${id}/approve`, { appr: [60], note: "" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Give a quantity for each of the 2 lines");
  });

  it("decides once, however many screens press together", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }] });
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u5", `/requisitions/${id}/approve`, { appr: [60], note: "" }),
      post("u5", `/requisitions/${id}/approve`, { appr: [30], note: "" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    expect((await one(id)).hist.filter((h: { s: string }) => h.s !== "Sent")).toHaveLength(1);
  });

  it("404s a requisition that is not there, and is absent for every other role", async () => {
    expect((await post("u5", "/requisitions/PRQ-2026-999/approve", { appr: [1], note: "" })).json().error.message)
      .toBe("There is no requisition PRQ-2026-999.");
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 1 }] });
    for (const u of ["u1", "u2", "u3", "u4"]) {
      expect((await post(u, `/requisitions/${id}/approve`, { appr: [1], note: "" })).statusCode).toBe(404);
    }
  });
});

describe("POST /requisitions/:id/decline", () => {
  it("declines with a reason, and every line's shortfall is the whole ask", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }] });
    const b = (await post("u5", `/requisitions/${id}/decline`, { note: "Vendor cannot supply this week" })).json();
    expect(b.result.st).toBe("Declined");
    expect(b.result.lines.map((l: { appr: number; short: number }) => [l.appr, l.short])).toEqual([[0, 60], [0, 6]]);
    expect(b.result.apprNote).toBe("Vendor cannot supply this week");
    expect(b.message).toBe(`${id} declined`);
  });

  it("will not decline without one, and will not decide twice", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }] });
    expect((await post("u5", `/requisitions/${id}/decline`, { note: "   " })).json().error.message)
      .toBe("Give a reason - the store keeper sees it on the requisition");
    await post("u5", `/requisitions/${id}/decline`, { note: "No" });
    const again = await post("u5", `/requisitions/${id}/decline`, { note: "No" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe(`${id} is already declined`);
  });
});
