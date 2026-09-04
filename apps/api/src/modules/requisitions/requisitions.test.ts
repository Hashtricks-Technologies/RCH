import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
/** The requisition desk, off `GET /snapshot` — `GET /requisitions` is Task 4's and lands in
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
    expect(b.message).toBe(`${id} approved — 2 line(s) on the procurement list`);
  });

  it("never approves more than was asked, and records the shortfall", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }, { it: "butter", qty: 6 }] });
    const b = (await post("u5", `/requisitions/${id}/approve`, { appr: [999, 4], note: "" })).json();
    expect(b.result.st).toBe("Partially approved");
    expect(b.result.lines[0]).toMatchObject({ appr: 60, short: 0 });
    expect(b.result.lines[1]).toMatchObject({ appr: 4, short: 2 });
    expect(b.message).toBe(`${id} partially approved — 2 line(s) on the procurement list`);
  });

  it("leaves a claim a live order already holds exactly where it is", async () => {
    // A requisition can be re-decided only once, so this is about the write, not a second pass:
    // approving must not touch ordered_qty, or a claimed quantity would reappear on the list.
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60, ordered: 25 }] });
    const b = (await post("u5", `/requisitions/${id}/approve`, { appr: [60], note: "" })).json();
    expect(b.result.lines[0]).toMatchObject({ appr: 60, ordered: 25 });
  });

  it("treats an all-zero approval as a decline, and wants a reason for it", async () => {
    const id = await given.requisition(app.testDb!.db, { lines: [{ it: "milk", qty: 60 }] });
    const bare = await post("u5", `/requisitions/${id}/approve`, { appr: [0], note: "  " });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().error.message).toBe("Give a reason — the store keeper sees it on the requisition");
    expect((await one(id)).st).toBe("Sent");

    const b = (await post("u5", `/requisitions/${id}/approve`, { appr: [0], note: "Vendor cannot supply" })).json();
    expect(b.result.st).toBe("Declined");
    expect(b.result.lines[0]).toMatchObject({ appr: 0, short: 60 });
    expect(b.message).toBe(`${id} declined — nothing goes on the procurement list`);
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
      .toBe("Give a reason — the store keeper sees it on the requisition");
    await post("u5", `/requisitions/${id}/decline`, { note: "No" });
    const again = await post("u5", `/requisitions/${id}/decline`, { note: "No" });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.message).toBe(`${id} is already declined`);
  });
});
