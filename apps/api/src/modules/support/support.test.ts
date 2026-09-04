import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SupportTicket } from "@rch/contract";
import type { App } from "../../app.js";
import { buildTestApp } from "../../test/app.js";
import { truncateAll, warmPool } from "../../test/db.js";
import { seedTestDb } from "../../test/seed.js";
import { authHeaders } from "../../test/auth.js";
import { given } from "../../test/builders.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "support" }); await app.ready(); });
// `buildTestApp` migrates but does NOT seed, and `authHeaders` throws
// `no user u1 - did you seed?` without this. Copy the shape from
// `modules/tickets/tickets.test.ts:15-17`; every DB-backed module suite has it.
beforeEach(async () => { await truncateAll(app.testDb!.db); await seedTestDb(app.testDb!.db); });
afterAll(async () => { await app.close(); });

const list = async (userId: string) => {
  const res = await app.inject({ method: "GET", url: "/api/v1/support/tickets", headers: await authHeaders(app, userId) });
  expect(res.statusCode).toBe(200);
  return res.json() as SupportTicket[];
};

const post = async (userId: string, path: string, payload?: unknown) =>
  app.inject({ method: "POST", url: `/api/v1/support${path}`, headers: { ...(await authHeaders(app, userId)), "idempotency-key": randomUUID() }, payload: payload ?? {} });

describe("GET /support/tickets", () => {
  it("answers with the caller's own tickets and nobody else's, in every role", async () => {
    const mine = await given.supportTicket(app.db, { by: "u1", subject: "Mine" });
    const theirs = await given.supportTicket(app.db, { by: "u3", subject: "Theirs" });

    const asCounter = await list("u1");
    expect(asCounter.map((t) => t.id)).toContain(mine);
    expect(asCounter.map((t) => t.id)).not.toContain(theirs);

    // The store keeper is not a support agent either: own tickets, same as everyone.
    const asStore = await list("u3");
    expect(asStore.map((t) => t.id)).toContain(theirs);
    expect(asStore.map((t) => t.id)).not.toContain(mine);
  });

  it("is open to every role — support is the one module all five share (§8.3)", async () => {
    for (const u of ["u1", "u2", "u3", "u4", "u5"]) {
      const res = await app.inject({ method: "GET", url: "/api/v1/support/tickets", headers: await authHeaders(app, u) });
      expect(res.statusCode).toBe(200);
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/support/tickets" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /support/tickets", () => {
  it("raises a ticket for whoever is signed in, with their first message on it", async () => {
    const before = (await list("u1")).length;
    const res = await post("u1", "/tickets", { topic: "A number looks wrong", subject: "Cash reads zero", body: "Since 09:00.", priority: "Urgent", screen: "Dashboard" });
    expect(res.statusCode).toBe(200);
    const { result, changed, message } = res.json() as { result: SupportTicket; changed: string[]; message: string };

    expect(result.id).toMatch(/^SUP-00\d+$/);
    expect(result.st).toBe("Open");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].from).toBe("user");
    expect(changed).toEqual(["tickets"]);
    expect(message).toBe(`${result.id} raised — support replies to urgent tickets within the hour`);
    expect(await list("u1")).toHaveLength(before + 1);
  });

  it("continues the visible series rather than restarting it", async () => {
    const a = await post("u1", "/tickets", { topic: "Something else", subject: "One", body: "", priority: "Low", screen: "Dashboard" });
    const b = await post("u1", "/tickets", { topic: "Something else", subject: "Two", body: "", priority: "Low", screen: "Dashboard" });
    const n = (r: typeof a) => Number((r.json() as { result: SupportTicket }).result.id.slice(4));
    expect(n(b)).toBe(n(a) + 1);
  });

  it("takes a ticket with no detail, and leaves the conversation empty", async () => {
    const res = await post("u1", "/tickets", { topic: "Feature request", subject: "A weekly total", body: "   ", priority: "Low", screen: "Dashboard" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { result: SupportTicket }).result.messages).toEqual([]);
  });

  it("refuses one with no subject, in the store's own words, and writes nothing", async () => {
    const before = (await list("u1")).length;
    const res = await post("u1", "/tickets", { topic: "Something else", subject: "   ", body: "x", priority: "Low", screen: "Dashboard" });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { message: string } }).error.message).toBe("Give the ticket a subject so support knows what it is about");
    expect(await list("u1")).toHaveLength(before);
  });

  it("replays a repeated key without raising a second ticket", async () => {
    const k = randomUUID();
    const body = { topic: "Something else", subject: "Twice", body: "", priority: "Low", screen: "Dashboard" };
    const headers = { ...(await authHeaders(app, "u1")), "idempotency-key": k };
    const first = await app.inject({ method: "POST", url: "/api/v1/support/tickets", headers, payload: body });
    const second = await app.inject({ method: "POST", url: "/api/v1/support/tickets", headers, payload: body });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect((await list("u1")).filter((t) => t.subject === "Twice")).toHaveLength(1);
  });
});

describe("POST /support/tickets/:id/messages", () => {
  it("puts a ticket the desk was waiting on back with support", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "Waiting on you" });
    const res = await post("u1", `/tickets/${id}/messages`, { body: "Refreshed and it reads right now." });
    expect(res.statusCode).toBe(200);
    const { result, message } = res.json() as { result: SupportTicket; message: string };
    expect(result.st).toBe("With support");
    expect(result.messages.at(-1)!.from).toBe("user");
    expect(message).toBe(`Reply sent on ${id}`);
  });

  it("reopens a resolved one, and leaves an open one where it is", async () => {
    const resolved = await given.supportTicket(app.db, { by: "u1", st: "Resolved" });
    expect(((await post("u1", `/tickets/${resolved}/messages`, { body: "It is back." })).json() as { result: SupportTicket }).result.st).toBe("With support");
    const open = await given.supportTicket(app.db, { by: "u1", st: "Open" });
    expect(((await post("u1", `/tickets/${open}/messages`, { body: "One more thing." })).json() as { result: SupportTicket }).result.st).toBe("Open");
  });

  it("refuses an empty reply and a closed ticket", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "With support" });
    expect((await post("u1", `/tickets/${id}/messages`, { body: "  " })).statusCode).toBe(422);
    const closed = await given.supportTicket(app.db, { by: "u1", st: "Closed" });
    const res = await post("u1", `/tickets/${closed}/messages`, { body: "Hello?" });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { message: string } }).error.message).toBe(`${closed} is closed — raise a new ticket if it has come back`);
  });

  it("refuses somebody else's ticket as though it were not there", async () => {
    const theirs = await given.supportTicket(app.db, { by: "u3" });
    const res = await post("u1", `/tickets/${theirs}/messages`, { body: "Nosy." });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { message: string } }).error.message).toBe(`There is no support ticket ${theirs}.`);
  });
});

describe("POST /support/tickets/:id/status", () => {
  it("lets the person who raised it resolve it and close it", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "With support" });
    expect(((await post("u1", `/tickets/${id}/status`, { st: "Resolved" })).json() as { result: SupportTicket }).result.st).toBe("Resolved");
    expect(((await post("u1", `/tickets/${id}/status`, { st: "Closed" })).json() as { result: SupportTicket }).result.st).toBe("Closed");
  });

  it("refuses the desk's own three words", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "Open" });
    for (const st of ["With support", "Waiting on you", "Open"]) {
      const res = await post("u1", `/tickets/${id}/status`, { st });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { error: { message: string } }).error.message)
        .toBe(`Only support moves a ticket to ${st.toLowerCase()} — you can mark it resolved or close it`);
    }
  });

  it("refuses a move the table does not have", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "Closed" });
    expect((await post("u1", `/tickets/${id}/status`, { st: "Resolved" })).statusCode).toBe(422);
  });

  it("writes one status, not two, when two taps race", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "With support" });
    // `warmPool(app.testDb!, n)` — the shape every existing race case in this repo uses.
    await warmPool(app.testDb!, 2);
    // Both taps ask for the *same* word, which is the case `supportRepo.head`'s lock exists for
    // and the one the operator actually produces: a double-tap on "Mark resolved". It is also the
    // only pair that proves the lock whichever request wins it. Racing `Resolved` against
    // `Closed` does not: `Resolved -> Closed` is a legal edge, so if the `Resolved` tap took the
    // lock first the second would pass its guard honestly and both would answer 200 — the
    // assertion below would then fail for a reason that has nothing to do with the lock.
    const [a, b] = await Promise.all([
      post("u1", `/tickets/${id}/status`, { st: "Resolved" }),
      post("u1", `/tickets/${id}/status`, { st: "Resolved" }),
    ]);
    expect([a.statusCode, b.statusCode].filter((c) => c === 200)).toHaveLength(1);
    // The loser read the winner's row, not the row they both started from.
    const refused = [a, b].find((r) => r.statusCode === 422)!;
    expect((refused.json() as { error: { message: string } }).error.message).toBe(`${id} is already resolved`);
    expect((await list("u1")).find((t) => t.id === id)!.st).toBe("Resolved");
  });
});

describe("POST /support/tickets/:id/rating", () => {
  it("records a rating once the desk has resolved it", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "Resolved" });
    const res = await post("u1", `/tickets/${id}/rating`, { rating: 5 });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { result: SupportTicket }).result.rating).toBe(5);
    expect((res.json() as { message: string }).message).toBe(`Thank you — 5 out of 5 recorded against ${id}`);
  });

  it("refuses one on a ticket that is still running", async () => {
    const id = await given.supportTicket(app.db, { by: "u1", st: "With support" });
    const res = await post("u1", `/tickets/${id}/rating`, { rating: 5 });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: { message: string } }).error.message).toBe(`${id} is not finished yet — rate it once support has resolved it`);
  });
});
