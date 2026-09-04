import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../../test/app.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";
import { truncateAll, warmPool } from "../../test/db.js";
import { reservations, stockBalances, stockMoves, stockRequestLines, stockRequests } from "../../db/schema/index.js";
import { rebuildBalances } from "../../lib/ledger.js";
import type { InjectOptions } from "fastify";
import type { App } from "../../app.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "requests" }); await app.ready(); });
afterAll(async () => { await app.close(); });
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });

const hdr = async (id: string) => ({ ...(await authHeaders(app, id)), "idempotency-key": randomUUID() });
/** Cancel and issue-ticket carry no body, so the payload is optional — spread in rather than
 *  sent as `undefined`, which inject would still turn into an empty body. */
const post = async (user: string, url: string, payload?: object) => {
  const opts: InjectOptions = { method: "POST", url: `/api/v1${url}`, headers: await hdr(user) };
  if (payload !== undefined) opts.payload = payload;
  return app.inject(opts);
};
/** Every balance row, as one comparable object — for the rebuild that must change nothing. */
const onHand = async (): Promise<Record<string, number>> =>
  Object.fromEntries((await app.testDb!.db.select().from(stockBalances)).map((b) => [`${b.loc}:${b.itemKey}`, b.onHand]));

describe("POST /requests", () => {
  it("a counter raises a multi-line request from their own counter", async () => {
    const r = await post("u1", "/requests", { lines: [{ it: "milk", qty: 20 }, { it: "sugar", qty: 4 }], note: "Counter runs dry by 4pm", urgent: true });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    // Never a literal id: `truncateAll` deliberately keeps `sequences` (apps/api/src/test/db.ts)
    // and `ensureSequences` is onConflictDoNothing, so the series carries on across cases.
    expect(b.result.id).toMatch(/^REQ-\d{4}-0\d+$/);
    expect(b.result).toMatchObject({ from: "coffee", by: "Kavitha Raman", st: "Request sent", ticket: null, mgrNote: "Counter runs dry by 4pm", urg: true });
    expect(b.result.lines).toEqual([{ it: "milk", qty: 20, appr: 0 }, { it: "sugar", qty: 4, appr: 0 }]);
    expect(b.result.hist).toEqual([{ s: "Request sent", who: "Kavitha Raman", t: expect.any(String) }]);
    expect(b.changed).toEqual(["req"]);
    expect(b.message).toBe(`${b.result.id} sent to the outlet manager — 2 lines`);
  });

  it("issues the next number in the series each time", async () => {
    const first = (await post("u1", "/requests", { lines: [{ it: "milk", qty: 1 }] })).json().result.id;
    const second = (await post("u1", "/requests", { lines: [{ it: "milk", qty: 1 }] })).json().result.id;
    const n = (id: string) => Number(id.slice("REQ-2026-0".length));
    expect(n(second)).toBe(n(first) + 1);
  });

  it("names the item when only one line was asked for", async () => {
    const r = await post("u1", "/requests", { lines: [{ it: "milk", qty: 20 }] });
    expect(r.json().message).toBe(`${r.json().result.id} raised for 20 Milk 1L (toned) — with the outlet manager now`);
  });

  it("lets the kitchen raise one too, from the kitchen", async () => {
    const r = await post("u4", "/requests", { lines: [{ it: "maida", qty: 10 }], note: "Raised from Central Kitchen stock screen" });
    expect(r.statusCode).toBe(200);
    expect(r.json().result.from).toBe("kitchen");
  });

  it("refuses a line with no quantity, in the operator's words (C3)", async () => {
    const r = await post("u1", "/requests", { lines: [{ it: "milk", qty: 0 }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Add at least one line with a quantity");
  });

  it("refuses two lines of the same item, where the counter can still fix it", async () => {
    // One item, one line. Decided twice against the same free-to-promise it would promise the
    // shelf twice over, and the ticket folds the two into one line the request no longer matches.
    const r = await post("u1", "/requests", { lines: [{ it: "milk", qty: 8 }, { it: "sugar", qty: 2 }, { it: "milk", qty: 8 }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Combine the Milk 1L (toned) lines into one");
  });

  it("404s an item the master does not have", async () => {
    const r = await post("u1", "/requests", { lines: [{ it: "totally-fake", qty: 1 }] });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe("There is no item totally-fake.");
  });

  it("is absent for a manager", async () => {
    expect((await post("u2", "/requests", { lines: [{ it: "milk", qty: 1 }] })).statusCode).toBe(404);
  });

  it("refuses without an Idempotency-Key, and replays one", async () => {
    const headers = await hdr("u1");
    const payload = { lines: [{ it: "milk", qty: 20 }] };
    // The replay must return the first response byte for byte — including its id.
    expect((await app.inject({ method: "POST", url: "/api/v1/requests", headers: await authHeaders(app, "u1"), payload })).statusCode).toBe(400);
    const first = await app.inject({ method: "POST", url: "/api/v1/requests", headers, payload });
    const again = await app.inject({ method: "POST", url: "/api/v1/requests", headers, payload });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(again.headers["idempotency-replayed"]).toBeDefined();
  });
});

describe("POST /requests/:id/cancel", () => {
  it("cancels only while the request is still open", async () => {
    const open = await post("u1", "/requests/REQ-2026-0911/cancel");
    expect(open.statusCode).toBe(200);
    expect(open.json().result.st).toBe("Cancelled");
    expect(open.json().message).toBe("REQ-2026-0911 cancelled");
    // Contained, not last: `readHistory` sorts on the row's own time and the seeded trail is
    // stamped at fixed times of day (09:14 for this one), so whether a row written *now* lands
    // at the end depends on the wall clock the suite happens to run at.
    expect(open.json().result.hist).toContainEqual({ s: "Cancelled", who: "Kavitha Raman", t: expect.any(String) });

    const gone = await post("u1", "/requests/REQ-2026-0909/cancel");     // already Ticket issued
    expect(gone.statusCode).toBe(422);
    expect(gone.json().error.message).toBe("REQ-2026-0909 is already ticket issued");
  });

  it("refuses to cancel another outlet's request", async () => {
    const r = await post("u6", "/requests/REQ-2026-0911/cancel");        // u6 is at kiosk, 0911 is coffee's
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe("You can only do this for your own counter.");
  });

  it("404s an id that is not there", async () => {
    const r = await post("u1", "/requests/REQ-2026-9999/cancel");
    expect(r.json().error.message).toBe("There is no request REQ-2026-9999.");
    expect(r.statusCode).toBe(404);
  });
});

describe("POST /requests/:id/approve", () => {
  it("trims to what the store can cover and records the shortfall (C4, C6)", async () => {
    const r = await post("u2", "/requests/REQ-2026-0911/approve", { appr: [20], note: "Store only holds 12 L." });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result.request.lines[0]).toEqual({ it: "milk", qty: 20, appr: 12, short: 8 });   // store holds 12 L
    expect(b.result.request.st).toBe("Partially approved");
    expect(b.result.request.mgrNote).toBe("Store only holds 12 L.");
    expect(b.result.request.ticket).toBeNull();
    expect(b.result.trimmed).toBe(true);
    expect(b.changed).toEqual(["req"]);
    expect(b.message).toBe("REQ-2026-0911 trimmed — the central store cannot cover the full quantity");
  });

  it("names the manager who approved, not the operator who raised (H6)", async () => {
    const r = await post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" });
    expect(r.json().result.request.apprBy).toBe("Ramesh Kumar");
    expect(r.json().result.request.by).toBe("Kavitha Raman");
    expect(r.json().result.request.hist).toContainEqual({ s: "Partially approved", who: "Ramesh Kumar", t: expect.any(String) });
  });

  it("nets an approval already made against the next one (C6)", async () => {
    await post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" });    // takes all 12 L
    const second = await given.request(app.testDb!.db, { from: "coffee", lines: [{ it: "milk", qty: 10 }] });
    const r = await post("u2", `/requests/${second}/approve`, { appr: [10], note: "" });
    expect(r.json().result.request.lines[0].appr).toBe(0);
    expect(r.json().result.request.st).toBe("Rejected");
    // The store, not the manager, cut this to nothing — so the manager reads that the store
    // could not cover it, exactly as the counter's own `approveRequest` reports it: `trimmed`
    // is tested before the status, and a decision trimmed all the way to zero is still trimmed.
    expect(r.json().result.trimmed).toBe(true);
    expect(r.json().message).toBe(`${second} trimmed — the central store cannot cover the full quantity`);
  });

  it("says rejected — no ticket — when the manager is the one who typed zero", async () => {
    const id = await given.request(app.testDb!.db, { from: "kiosk", lines: [{ it: "sugar", qty: 5 }] });
    const r = await post("u2", `/requests/${id}/approve`, { appr: [0], note: "Kiosk has plenty" });
    expect(r.json().result.request.st).toBe("Rejected");
    expect(r.json().result.trimmed).toBe(false);
    expect(r.json().message).toBe(`${id} rejected — no ticket will be issued`);
  });

  it("nets the stock a live ticket is already holding (C6)", async () => {
    // TKT-0440 is Issued and holds 500 of the store's 2400 cups, so only 1900 are free to
    // promise. Drop the open-reservation term and the manager would promise all 2000.
    const id = await given.request(app.testDb!.db, { from: "coffee", lines: [{ it: "cup", qty: 2000 }] });
    const r = await post("u2", `/requests/${id}/approve`, { appr: [2000], note: "" });
    expect(r.json().result.request.lines[0]).toEqual({ it: "cup", qty: 2000, appr: 1900, short: 100 });
    expect(r.json().result.request.st).toBe("Partially approved");
    expect(r.json().result.trimmed).toBe(true);
  });

  it("approves in full and forwards it, with no shortfall", async () => {
    const id = await given.request(app.testDb!.db, { from: "kiosk", lines: [{ it: "sugar", qty: 5 }, { it: "butter", qty: 1 }] });
    const r = await post("u2", `/requests/${id}/approve`, { appr: [5, 1], note: "All of it" });
    expect(r.json().result.request.st).toBe("Manager approved");
    expect(r.json().result.trimmed).toBe(false);
    expect(r.json().result.request.lines.every((l: { short: number }) => l.short === 0)).toBe(true);
    expect(r.json().message).toBe(`${id} manager approved and forwarded to the store keeper`);
  });

  it("refuses a decision that does not carry a quantity for every line", async () => {
    // `planApproval` reads `appr[i]` beside `lines[i]`, so a short array quietly approves
    // nothing on the lines it never reaches, and a long one carries a decision about a line
    // that is not there. A screen opened before the counter added a line is exactly how one
    // arrives, and the manager would never see what they had just refused.
    const id = await given.request(app.testDb!.db, { from: "kiosk", lines: [{ it: "sugar", qty: 5 }, { it: "milk", qty: 2 }] });
    // An empty array never gets here — `ApproveRequestBodySchema` asks for at least one, so it
    // is a 400 at the door. One too few and one too many are the shapes a real screen sends.
    for (const appr of [[12], [12, 2, 1]]) {
      const r = await post("u2", `/requests/${id}/approve`, { appr, note: "" });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error).toMatchObject({ code: "rule", message: "Give a quantity for each of the 2 lines" });
    }
    const [after] = await app.testDb!.db.select().from(stockRequests).where(eq(stockRequests.id, id));
    expect(after.status).toBe("Request sent");
    expect(after.approvedBy).toBeNull();
    const lines = await app.testDb!.db.select().from(stockRequestLines).where(eq(stockRequestLines.requestId, id));
    expect(lines.every((l) => l.approvedQty === 0)).toBe(true);
  });

  it("refuses a second decision on a request already decided", async () => {
    const r = await post("u2", "/requests/REQ-2026-0910/approve", { appr: [5, 1], note: "" });   // already Manager approved
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("REQ-2026-0910 is already manager approved");
  });

  it("decides once when two managers press at once", async () => {
    // Nothing but the `for update` on the request row stands between these two: an approval
    // writes no reservation, so there is no balance lock to fall back on. Comment out
    // `.for("update")` in repo.head and both decisions land.
    await warmPool(app.testDb!, 2);
    const both = await Promise.all([
      post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" }),
      post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" }),
    ]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });

  it("is absent for a counter and for the store", async () => {
    for (const u of ["u1", "u3"]) expect((await post(u, "/requests/REQ-2026-0911/approve", { appr: [12], note: "" })).statusCode).toBe(404);
  });
});

describe("POST /requests/:id/reject", () => {
  it("refuses to reject without a reason (H7)", async () => {
    const r = await post("u2", "/requests/REQ-2026-0912/reject", { note: "   " });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Give a reason — the counter sees it on the request");
    const still = await app.inject({ method: "GET", url: "/api/v1/requests", headers: await authHeaders(app, "u2") });
    expect(still.json().find((x: { id: string }) => x.id === "REQ-2026-0912").st).toBe("Request sent");
  });

  it("rejects when a reason is given, and issues no ticket", async () => {
    const r = await post("u2", "/requests/REQ-2026-0912/reject", { note: "Kiosk is overstocked already" });
    expect(r.json().result.st).toBe("Rejected");
    expect(r.json().result.mgrNote).toBe("Kiosk is overstocked already");
    expect(r.json().message).toBe("REQ-2026-0912 rejected");
    const issue = await post("u3", "/requests/REQ-2026-0912/issue-ticket");
    expect(issue.statusCode).toBe(422);
  });
});

describe("POST /requests/:id/issue-ticket", () => {
  it("issues for what was approved, reserves it, and moves nothing (the movement rule)", async () => {
    await post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" });
    const movesBefore = (await app.testDb!.db.select().from(stockMoves)).length;
    const balancesBefore = await onHand();

    const r = await post("u3", "/requests/REQ-2026-0911/issue-ticket");
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.result.ticket).toMatchObject({ id: "TKT-0441", req: "REQ-2026-0911", from: "store", to: "coffee", st: "Issued" });
    expect(b.result.ticket.lines).toEqual([{ it: "milk", qty: 12 }]);
    // The store keeper raising the ticket stands at the location it leaves from, so the six
    // digits are not in the answer. They are on the row, and the coffee shop — the location
    // collecting — is the only one that reads them, through its own snapshot.
    expect(b.result.ticket.otp).toBe("");
    expect(b.result.request.st).toBe("Ticket issued");
    expect(b.result.request.ticket).toBe("TKT-0441");
    expect(b.changed).toEqual(["req", "tkt", "rsv"]);
    expect(b.message).toBe("TKT-0441 issued — Coffee Shop can collect against this ticket");

    // Approval authorises; the scan moves. Nothing left the store.
    expect((await app.testDb!.db.select().from(stockMoves)).length).toBe(movesBefore);
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, "TKT-0441"));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ loc: "store", itemKey: "milk", qty: 12, releasedAt: null });

    // …and because nothing moved, recomputing every balance from the moves changes nothing.
    // The cache and the ledger still agree after an issue, which is the whole claim.
    await rebuildBalances(app.testDb!.db);
    expect(await onHand()).toEqual(balancesBefore);
  });

  it("refuses a request with nothing approved on it", async () => {
    const id = await given.request(app.testDb!.db, { from: "kiosk", lines: [{ it: "sugar", qty: 5, appr: 0 }], st: "Partially approved" });
    const r = await post("u3", `/requests/${id}/issue-ticket`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Nothing approved on this request");
  });

  it("refuses when the approval has gone stale and the store can no longer cover it", async () => {
    // Approved for 12 L, then a second ticket takes the same milk before the store keeper acts.
    await post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" });
    await given.ticket(app.testDb!.db, { from: "store", to: "kiosk", lines: [{ it: "milk", qty: 12 }] });
    const r = await post("u3", "/requests/REQ-2026-0911/issue-ticket");
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Not enough Milk 1L (toned) available to promise");
  });

  it("folds a repeated item into one cover check before promising it", async () => {
    // `POST /requests` refuses a repeat, so this is a row written before that rule. Checked
    // line by line, 8 and 8 each clear the store's 12 L and `writeTicket` would then reserve
    // 16 — free-to-promise four litres in the red. The check has to see the folded 16.
    const id = await given.request(app.testDb!.db, {
      from: "coffee", st: "Manager approved", lines: [{ it: "milk", qty: 8, appr: 8 }, { it: "milk", qty: 8, appr: 8 }],
    });
    const r = await post("u3", `/requests/${id}/issue-ticket`);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("Not enough Milk 1L (toned) available to promise");
    expect(await app.testDb!.db.select().from(reservations).where(eq(reservations.itemKey, "milk"))).toHaveLength(0);
  });

  it("issues one line and one hold for a repeated item that does fit", async () => {
    const id = await given.request(app.testDb!.db, {
      from: "coffee", st: "Manager approved", lines: [{ it: "milk", qty: 5, appr: 5 }, { it: "milk", qty: 4, appr: 4 }],
    });
    const r = await post("u3", `/requests/${id}/issue-ticket`);
    expect(r.statusCode).toBe(200);
    expect(r.json().result.ticket.lines).toEqual([{ it: "milk", qty: 9 }]);
    const held = await app.testDb!.db.select().from(reservations).where(eq(reservations.ticketId, r.json().result.ticket.id));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ loc: "store", itemKey: "milk", qty: 9, releasedAt: null });
  });

  it("refuses a request that already has a ticket", async () => {
    const r = await post("u3", "/requests/REQ-2026-0909/issue-ticket");   // already Ticket issued
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toBe("REQ-2026-0909 is already ticket issued");
  });

  it("issues exactly one ticket when two store keepers press at once", async () => {
    await warmPool(app.testDb!, 2);
    await post("u2", "/requests/REQ-2026-0911/approve", { appr: [12], note: "" });
    const both = await Promise.all([post("u3", "/requests/REQ-2026-0911/issue-ticket"), post("u3", "/requests/REQ-2026-0911/issue-ticket")]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
  });

  it("issues one ticket even when the shelf could cover both (the row lock, not the stock)", async () => {
    // The case above is also caught by the post-lock cover re-read, because the store holds
    // exactly the 12 L it promised. Here the store holds 40 kg of sugar against 2 kg approved,
    // so the cover check passes twice and only the `for update` on the request row refuses the
    // second press. Comment it out in repo.head and two tickets are issued for one request.
    await warmPool(app.testDb!, 2);
    const id = await given.request(app.testDb!.db, { from: "kiosk", lines: [{ it: "sugar", qty: 2, appr: 2 }], st: "Manager approved" });
    const both = await Promise.all([post("u3", `/requests/${id}/issue-ticket`), post("u3", `/requests/${id}/issue-ticket`)]);
    expect(both.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(both.filter((r) => r.statusCode === 422)).toHaveLength(1);
    expect(both.find((r) => r.statusCode === 422)!.json().error.message).toBe(`${id} is already ticket issued`);
  });

  it("is absent for a counter and a manager", async () => {
    for (const u of ["u1", "u2"]) expect((await post(u, "/requests/REQ-2026-0911/issue-ticket")).statusCode).toBe(404);
  });
});
