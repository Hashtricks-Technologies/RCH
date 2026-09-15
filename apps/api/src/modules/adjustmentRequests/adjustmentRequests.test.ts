import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { resetDocuments, truncateAll } from "../../test/db.js";
import { adjustmentRequests, adjustments, documentHistory, stockBalances } from "../../db/schema/index.js";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => {
  app = await buildTestApp({ schema: "adjustment_requests" });
  await app.ready();
  await truncateAll(app.testDb!.db);
  await seedTestDb(app.testDb!.db);
});
afterAll(async () => { await app.close(); });
beforeEach(async () => { await resetDocuments(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
const post = async (user: string, url: string, payload?: object) => {
  const opts: InjectOptions = { method: "POST", url: `/api/v1${url}`, headers: await hdr(user) };
  if (payload !== undefined) opts.payload = payload;
  return app.inject(opts);
};
const get = async (user: string, url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: await authHeaders(app, user) });
const balance = async (loc: string, it: string): Promise<number | undefined> => {
  const [row] = await app.testDb!.db.select().from(stockBalances).where(and(eq(stockBalances.loc, loc), eq(stockBalances.itemKey, it)));
  return row?.onHand;
};

describe("POST /adjustment-requests", () => {
  it("a counter raises a multi-line ask against its own shelf", async () => {
    const r = await post("u1", "/adjustment-requests", {
      reason: "wastage", note: "Fridge failed overnight", lines: [{ it: "cup", qty: -20 }, { it: "sugar", qty: -1 }],
    });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.id).toMatch(/^ADJREQ-\d{4}-0\d+$/);
    expect(b.result).toMatchObject({ loc: "coffee", reason: "wastage", note: "Fridge failed overnight", by: "Kavitha Raman", st: "Request sent" });
    expect(b.result.lines).toEqual([{ it: "cup", qty: -20 }, { it: "sugar", qty: -1 }]);
    expect(b.result.hist).toEqual([{ s: "Request sent", who: "Kavitha Raman", t: expect.any(String) }]);
    expect(b.changed).toEqual(["adjReq"]);
    expect(b.message).toBe(`${b.result.id} sent to the outlet manager`);
    // Nothing moves yet - raising an ask is not the correction.
    expect(await balance("coffee", "cup")).toBe(180);
  });

  it("refuses a line that folds to nothing, in the operator's own words", async () => {
    const r = await post("u1", "/adjustment-requests", { reason: "wastage", lines: [{ it: "cup", qty: 0 }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Enter a quantity to write off or count up on at least one line");
  });

  it("refuses two lines of the same item, where the counter can still fix it", async () => {
    const r = await post("u1", "/adjustment-requests", { reason: "wastage", lines: [{ it: "cup", qty: -5 }, { it: "cup", qty: -2 }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Combine the Paper cup 150ml lines into one");
  });

  it("404s an item the master does not have", async () => {
    const r = await post("u1", "/adjustment-requests", { reason: "wastage", lines: [{ it: "totally-fake", qty: -1 }] });
    expect(r.statusCode).toBe(404);
  });

  it("is absent for every role but the counter - the manager decides, it does not raise", async () => {
    for (const user of ["u2", "u3", "u4", "u5"]) {
      const r = await post(user, "/adjustment-requests", { reason: "wastage", lines: [{ it: "milk", qty: -1 }] });
      expect(r.statusCode, `${user} -> ${r.statusCode}`).toBe(404);
    }
  });
});

describe("POST /adjustment-requests/:id/cancel", () => {
  it("lets the counter withdraw its own ask before the manager decides", async () => {
    const id = await given.adjustmentRequest(app.testDb!.db, { loc: "coffee", by: "u1", lines: [{ it: "cup", qty: -5 }] });
    const r = await post("u1", `/adjustment-requests/${id}/cancel`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.st).toBe("Cancelled");
  });

  it("refuses a counter cancelling another counter's ask", async () => {
    const id = await given.adjustmentRequest(app.testDb!.db, { loc: "coffee", by: "u1", lines: [{ it: "cup", qty: -5 }] });
    const r = await post("u6", `/adjustment-requests/${id}/cancel`);
    expect(r.statusCode).toBe(403);
  });

  it("lets the manager withdraw one too - hospital-wide, no location check", async () => {
    const id = await given.adjustmentRequest(app.testDb!.db, { loc: "kiosk", by: "u7", lines: [{ it: "water", qty: -2 }] });
    const r = await post("u2", `/adjustment-requests/${id}/cancel`);
    expect(r.statusCode, r.body).toBe(200);
  });

  it("refuses to cancel one already decided", async () => {
    const id = await given.adjustmentRequest(app.testDb!.db, { loc: "coffee", by: "u1", st: "Approved", lines: [{ it: "cup", qty: -5 }] });
    const r = await post("u1", `/adjustment-requests/${id}/cancel`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} is already approved`);
  });
});

describe("POST /adjustment-requests/:id/approve", () => {
  it("writes the ADJ- document, moves the shelf, and links the two documents together", async () => {
    const before = await balance("coffee", "cup");
    const id = await given.adjustmentRequest(app.testDb!.db, {
      loc: "coffee", by: "u1", reason: "breakage", note: "Box dropped", lines: [{ it: "cup", qty: -20 }],
    });

    const r = await post("u2", `/adjustment-requests/${id}/approve`);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.result.request.st).toBe("Approved");
    expect(b.result.request.adjId).toMatch(/^ADJ-\d{4}-\d+$/);
    expect(b.result.adjustment.id).toBe(b.result.request.adjId);
    expect(b.result.adjustment).toMatchObject({ loc: "coffee", reason: "breakage", note: "Box dropped" });
    expect(b.result.adjustment.lines).toEqual([{ it: "cup", qty: -20 }]);
    expect(b.changed).toEqual(["adjReq", "stock", "adjustments"]);
    expect(await balance("coffee", "cup")).toBe(before! - 20);

    // The document the register actually shows this under.
    const [adj] = await app.testDb!.db.select().from(adjustments).where(eq(adjustments.id, b.result.adjustment.id));
    expect(adj?.loc).toBe("coffee");
    const [row] = await app.testDb!.db.select().from(adjustmentRequests).where(eq(adjustmentRequests.id, id));
    expect(row?.adjustmentId).toBe(b.result.adjustment.id);
    expect(row?.approvedBy).toBe("u2");

    const hist = await app.testDb!.db.select().from(documentHistory).where(and(eq(documentHistory.docType, "adjustment_request"), eq(documentHistory.docId, id)));
    expect(hist.map((h) => h.status)).toEqual(["Request sent", "Approved"]);
  });

  it("refuses to approve more than the shelf has free - the same sentence a direct write-off gives", async () => {
    const id = await given.adjustmentRequest(app.testDb!.db, { loc: "coffee", by: "u1", lines: [{ it: "cup", qty: -99999 }] });
    const r = await post("u2", `/adjustment-requests/${id}/approve`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/^Cannot write off/);
    // Refused whole: the request stays undecided, nothing moved.
    const [row] = await app.testDb!.db.select().from(adjustmentRequests).where(eq(adjustmentRequests.id, id));
    expect(row?.status).toBe("Request sent");
  });

  it("refuses a second decision on a request already decided", async () => {
    const id = await given.adjustmentRequest(app.testDb!.db, { loc: "coffee", by: "u1", st: "Rejected", lines: [{ it: "cup", qty: -5 }] });
    const r = await post("u2", `/adjustment-requests/${id}/approve`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe(`${id} is already rejected`);
  });

  it("is the manager's alone", async () => {
    const id = await given.adjustmentRequest(app.testDb!.db, { loc: "coffee", by: "u1", lines: [{ it: "cup", qty: -5 }] });
    for (const user of ["u1", "u3", "u4", "u5"]) {
      const r = await post(user, `/adjustment-requests/${id}/approve`);
      expect(r.statusCode, `${user} -> ${r.statusCode}`).toBe(404);
    }
  });
});

describe("POST /adjustment-requests/:id/reject", () => {
  it("refuses with a reason the counter can read", async () => {
    const id = await given.adjustmentRequest(app.testDb!.db, { loc: "coffee", by: "u1", lines: [{ it: "cup", qty: -5 }] });
    const r = await post("u2", `/adjustment-requests/${id}/reject`, { note: "Count it again before writing it off" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().result.st).toBe("Rejected");
    expect(await balance("coffee", "cup")).toBe(180);
  });

  it("refuses an empty reason", async () => {
    const id = await given.adjustmentRequest(app.testDb!.db, { loc: "coffee", by: "u1", lines: [{ it: "cup", qty: -5 }] });
    const r = await post("u2", `/adjustment-requests/${id}/reject`, { note: "" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Give a reason - the counter sees it on the request");
  });
});

describe("GET /adjustment-requests", () => {
  it("shows a counter only its own outlet's asks, and everyone else the whole queue", async () => {
    await given.adjustmentRequest(app.testDb!.db, { loc: "coffee", by: "u1", lines: [{ it: "cup", qty: -1 }] });
    await given.adjustmentRequest(app.testDb!.db, { loc: "kiosk", by: "u7", lines: [{ it: "water", qty: -1 }] });

    const mine = (await get("u1", "/adjustment-requests")).json();
    expect(mine.map((r: { loc: string }) => r.loc)).toEqual(["coffee"]);
    expect((await get("u2", "/adjustment-requests")).json()).toHaveLength(2);

    const snap = (await get("u1", "/snapshot")).json();
    expect(snap.adjReq.map((r: { loc: string }) => r.loc)).toEqual(["coffee"]);
    expect((await get("u2", "/snapshot")).json().adjReq).toHaveLength(2);
  });
});
