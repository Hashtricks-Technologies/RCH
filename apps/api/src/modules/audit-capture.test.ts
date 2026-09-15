import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { asc, desc, eq, gt, sql } from "drizzle-orm";
import { AUDIT_LABELS, AuditEventSchema, defineRoute, OkResponseSchema, routes, serviceOf, writeResponse, type AuditEvent } from "@rch/contract";
import { buildApp, type App } from "../app.js";
import { auditOutbox, bills, stockMoves, users } from "../db/schema/index.js";
import { MASK, auditBefore } from "../lib/audit.js";
import { withTransaction } from "../lib/db.js";
import { RuleError } from "../lib/errors.js";
import type { LogStream } from "../plugins/logging.js";
import { mount, mountedWrites } from "../routes.js";
import { buildTestApp, testConfig } from "../test/app.js";
import { authHeaders } from "../test/auth.js";
import { given } from "../test/builders.js";
import { seedTestDb } from "../test/seed.js";
import { meRepo } from "./me/repo.js";

let app: App;
beforeAll(async () => { app = await buildTestApp({ schema: "audit_capture" }); await seedTestDb(app.testDb!.db); await app.ready(); });
afterAll(async () => { await app.close(); });

/** A browser's own string, so the event's `userAgent` is provably the request's and not inject's default. */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

type Method = "POST" | "PUT" | "PATCH" | "DELETE";
/** A signed-in write with a fresh Idempotency-Key unless the case names one. Two inject calls
 *  rather than a spread payload, for the overload reason `tickets.test.ts` gives. */
const write = async (user: string, method: Method, url: string, payload?: object, key: string = randomUUID(), on: App = app) => {
  const headers = { ...(await authHeaders(on, user)), "idempotency-key": key, "user-agent": UA };
  return payload === undefined
    ? on.inject({ method, url: `/api/v1${url}`, headers })
    : on.inject({ method, url: `/api/v1${url}`, headers, payload });
};

/** The newest outbox id, so a case reads only the events it caused. `sequences` style: never a literal. */
const lastId = async (): Promise<number> =>
  (await app.db.select({ id: auditOutbox.id }).from(auditOutbox).orderBy(desc(auditOutbox.id)).limit(1))[0]?.id ?? 0;
/** Every event stored after `mark`, oldest first, each parsed exactly as the drainer will parse it.
 *  `auditSettled` first: a refusal's event is stored after its reply, so a read straight after
 *  `inject` could beat it - and a case asserting "no event" would pass for the wrong reason. */
const eventsSince = async (mark: number, on: App = app): Promise<AuditEvent[]> => {
  await on.auditSettled();
  return (await app.db.select().from(auditOutbox).where(gt(auditOutbox.id, mark)).orderBy(asc(auditOutbox.id))).map((r) => AuditEventSchema.parse(r.event));
};

const countRows = async (table: typeof bills | typeof stockMoves): Promise<number> => (await app.db.select().from(table)).length;
const phoneOf = async (id: string) => (await app.db.select().from(users).where(eq(users.id, id)))[0].phone;

/** An app of its own carrying a test-only write, mounted through the real `mount()` and sharing
 *  this file's schema - the `plugins/idempotency.test.ts` device. */
async function appWith(register: (a: App) => void, env: Partial<NodeJS.ProcessEnv> = {}, logStream?: LogStream): Promise<App> {
  const a = await buildApp(testConfig(env), { db: app.db, migrationsSchema: app.testDb!.schemaName, logStream });
  register(a);
  await a.ready();
  return a;
}

describe("every write the API serves is audited", () => {
  it("mounts each non-public API write in the manifest, and each has a label", () => {
    const writes = Object.entries(routes)
      .filter(([, r]) => serviceOf(r) === "api" && r.access !== "public" && (r.write ?? r.method !== "GET"))
      .map(([name]) => name)
      .sort();
    expect([...mountedWrites].sort()).toEqual(writes);
    for (const name of writes) expect(AUDIT_LABELS, name).toHaveProperty(name);
  });

  it("refuses to mount a route the audit service serves", () => {
    const audit = Object.values(routes).find((r) => serviceOf(r) === "audit");
    expect(audit).toBeDefined();
    expect(() => mount(app, audit!, async () => ({}) as never)).toThrow(/served by the audit service, not the API/);
  });
});

describe("a write that succeeds leaves exactly one done event", () => {
  it("a counter sale: the operator as they stand, the bill, its outlet and the sentence", async () => {
    const mark = await lastId();
    const body = { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }] };
    const r = await write("u1", "POST", "/bills", body);
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(await eventsSince(mark)).toEqual([{
      at: expect.any(String), requestId: r.headers["x-request-id"],
      actor: { id: "u1", emp: "RC-4471", name: "Kavitha Raman", role: "Counter Operator", loc: "coffee" },
      action: "pay", method: "POST", path: "/bills", target: b.result.no, targetLoc: "coffee",
      outcome: "done", status: 200, message: b.message, cause: null,
      request: { params: {}, query: {}, body },
      before: null, result: b.result, changed: ["stock", "bills"],
      ip: "127.0.0.1", userAgent: UA,
    }]);
  });

  it("a manager's price edit: the list and item as one target", async () => {
    const mark = await lastId();
    const r = await write("u2", "PUT", "/prices/A/juice", { price: 19 });
    expect(r.statusCode, r.body).toBe(200);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      actor: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" },
      action: "savePrice", method: "PUT", path: "/prices/:list/:it", target: "A:juice", targetLoc: "",
      outcome: "done", status: 200, message: "Real Juice 200ml priced at ₹19 on list A", changed: ["prices"],
      request: { params: { list: "A", it: "juice" }, query: {}, body: { price: 19 } },
      result: { list: "A", it: "juice", price: 19 },
    });
  });

  it("a manager's approval: the request it decided", async () => {
    const mark = await lastId();
    const r = await write("u2", "POST", "/requests/REQ-2026-0911/approve", { appr: [4], note: "Four today" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      actor: { id: "u2", role: "Outlet Manager" }, action: "approveRequest", path: "/requests/:id/approve",
      target: "REQ-2026-0911", outcome: "done", message: b.message, changed: b.changed, result: b.result,
    });
  });

  it("an admin's account create: the new account, with its temporary password masked", async () => {
    const mark = await lastId();
    const r = await write("u7", "POST", "/admin/users", { name: "Anitha R", email: "anitha.r@royalcare.in", role: "counter", loc: "rest" });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      actor: { id: "u7", emp: "RC-0001", name: "System Administrator", role: "Super Admin", loc: "" },
      action: "createAdminUser", target: b.result.id, targetLoc: "rest", outcome: "done", message: b.message, changed: ["accounts"],
    });
    expect(e.result).toEqual({ ...b.result, tempPassword: MASK });
    expect(JSON.stringify(e)).not.toContain(b.result.tempPassword);
  });

  it("an account's own edit: `PATCH /me` answers with no result key, so the whole answer is the result", async () => {
    const mark = await lastId();
    const r = await write("u6", "PATCH", "/me", { ph: "90000 00006" });
    expect(r.statusCode, r.body).toBe(200);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({ action: "patchMe", target: "", message: "", changed: [], actor: { id: "u6" } });
    expect(e.result).toEqual(r.json());
  });

  it("a handover: the ticket and where it left from, and never the code that was quoted", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "box", qty: 10 }], otp: "123456" });
    const mark = await lastId();
    const r = await write("u3", "POST", `/tickets/${id}/handover`, { otp: "123456" });
    expect(r.statusCode, r.body).toBe(200);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({ action: "handover", target: id, targetLoc: "store", outcome: "done", request: { body: { otp: MASK } }, result: { otp: MASK } });
    expect(JSON.stringify(e)).not.toContain("123456");
  });
});

describe("an edit's before value", () => {
  it("rides with the done event, masked, the last call winning", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-before", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => withTransaction(app.db, async (tx) => {
      auditBefore({ ph: "not this one" });
      auditBefore({ ph: await phoneOf("u1"), tempPassword: "Temp-5555" });
      await meRepo.update(tx, "u1", { phone: "74000 00007" });
      return { ok: true as const };
    })));
    try {
      const before = await phoneOf("u1");
      const mark = await lastId();
      const r = await write("u1", "POST", "/__test/audit-before", undefined, randomUUID(), a);
      expect(r.statusCode, r.body).toBe(200);
      const [e, ...more] = await eventsSince(mark);
      expect(more).toEqual([]);
      expect(e.before).toEqual({ ph: before, tempPassword: MASK });
    } finally {
      await a.close();
    }
  });

  it("is nothing to keep outside a write request", () => {
    expect(() => auditBefore({ ph: "12345 67890" })).not.toThrow();
  });
});

describe("the event commits with the write or not at all", () => {
  it("a write whose event cannot be stored does not commit", async () => {
    const mark = await lastId();
    const billsBefore = await countRows(bills);
    const movesBefore = await countRows(stockMoves);
    // NOT VALID: the rows already there stand, and every new one is refused.
    await app.db.execute(sql.raw("alter table audit_outbox add constraint audit_outbox_refuse_ck check (false) not valid"));
    try {
      const r = await write("u1", "POST", "/bills", { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }] });
      expect(r.statusCode).toBe(500);
      expect(await countRows(bills)).toBe(billsBefore);
      expect(await countRows(stockMoves)).toBe(movesBefore);
      // The 500's own event is refused by the same constraint; wait for that attempt to finish
      // before the constraint goes, or it would land afterwards.
      await app.auditSettled();
    } finally {
      await app.db.execute(sql.raw("alter table audit_outbox drop constraint audit_outbox_refuse_ck"));
    }
    expect(await eventsSince(mark)).toEqual([]);
  });

  it("a write whose transaction throws after its changes leaves no done event", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-late-refusal", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => withTransaction(app.db, async (tx) => {
      await meRepo.update(tx, "u1", { phone: "70000 00007" });
      throw new RuleError("Refused - staged after the change");
    })));
    try {
      const mark = await lastId();
      const phone = await phoneOf("u1");
      const r = await write("u1", "POST", "/__test/audit-late-refusal", undefined, randomUUID(), a);
      expect(r.statusCode).toBe(422);
      expect(await phoneOf("u1")).toBe(phone);
      const events = await eventsSince(mark, a);
      expect(events.filter((e) => e.outcome === "done")).toEqual([]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome: "refused", status: 422, message: "Refused - staged after the change", result: null, changed: [] });
    } finally {
      await a.close();
    }
  });

  it("a write that opens several transactions leaves one event, from the transaction that recorded its answer", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-multi", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => {
      // Commits a change and is not the answer - the shape `tickets.handover` takes for a wrong code.
      await withTransaction(app.db, async (tx) => { await meRepo.update(tx, "u1", { phone: "71000 00007" }); return { counted: true }; }, { response: "optional" });
      // The answer: recorded, and audited, here.
      const answer = await withTransaction(app.db, async (tx) => { await meRepo.update(tx, "u1", { phone: "72000 00007" }); return { ok: true as const }; });
      // After the answer: nothing left to record.
      await withTransaction(app.db, async (tx) => { await meRepo.update(tx, "u1", { phone: "73000 00007" }); return null; });
      return answer;
    }));
    try {
      const mark = await lastId();
      const r = await write("u1", "POST", "/__test/audit-multi", undefined, randomUUID(), a);
      expect(r.statusCode, r.body).toBe(200);
      const events = await eventsSince(mark, a);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "POST /__test/audit-multi", outcome: "done", status: 200, result: { ok: true }, message: "", changed: [], actor: { id: "u1" } });
    } finally {
      await a.close();
    }
  });
});

describe("a write that does not succeed leaves one event after its reply", () => {
  it("a rule refusal: refused, with the sentence the operator read", async () => {
    const mark = await lastId();
    const r = await write("u2", "PUT", "/prices/A/juice", { price: 25 });
    expect(r.statusCode).toBe(422);
    expect(await eventsSince(mark)).toEqual([{
      at: expect.any(String), requestId: r.headers["x-request-id"],
      actor: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" },
      action: "savePrice", method: "PUT", path: "/prices/:list/:it", target: "A:juice", targetLoc: "",
      outcome: "refused", status: 422, message: "Refused - printed MRP of ₹20 is a hard ceiling for Real Juice 200ml", cause: null,
      request: { params: { list: "A", it: "juice" }, query: {}, body: { price: 25 } },
      before: null, result: null, changed: [], ip: "127.0.0.1", userAgent: UA,
    }]);
  });

  it("a wrong-location refusal: the counter, and the outlet it reached for", async () => {
    const mark = await lastId();
    const r = await write("u1", "POST", "/bills", { loc: "kiosk", tender: "Cash", lines: [{ it: "chips", qty: 1 }] });
    expect(r.statusCode).toBe(403);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({ actor: { id: "u1" }, action: "pay", targetLoc: "kiosk", outcome: "refused", status: 403, message: "You can only do this for your own counter." });
  });

  it("a role-gate 404: the route that is not there for that role", async () => {
    const mark = await lastId();
    const r = await write("u1", "PUT", "/prices/A/juice", { price: 18 });
    expect(r.statusCode).toBe(404);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({ actor: { id: "u1", role: "Counter Operator" }, action: "savePrice", target: "A:juice", outcome: "refused", status: 404 });
  });

  it("a validation 400 from a signed-in caller: still named, though the body was refused before the token was checked", async () => {
    const mark = await lastId();
    const r = await write("u2", "PUT", "/prices/A/juice", { price: 0 });
    expect(r.statusCode).toBe(400);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      actor: { id: "u2", emp: "RC-3120" }, action: "savePrice", outcome: "refused", status: 400,
      message: "The request did not match what this endpoint expects.", request: { body: { price: 0 } },
    });
  });

  it("a refusal nobody can be named for leaves nothing: no token, or one that does not verify", async () => {
    const mark = await lastId();
    const bare = await app.inject({ method: "PUT", url: "/api/v1/prices/A/juice", headers: { "idempotency-key": randomUUID(), "user-agent": UA }, payload: { price: 0, note: "x".repeat(2000) } });
    expect(bare.statusCode).toBe(400);
    const forged = await app.inject({ method: "PUT", url: "/api/v1/prices/A/juice", headers: { authorization: "Bearer not-a-token", "idempotency-key": randomUUID() }, payload: { price: 0 } });
    expect(forged.statusCode).toBe(400);
    expect(await eventsSince(mark)).toEqual([]);
  });

  it("a wrong handover code: one refused event, and never the code that was typed", async () => {
    const id = await given.ticket(app.testDb!.db, { from: "store", to: "coffee", lines: [{ it: "box", qty: 5 }], otp: "123456" });
    const mark = await lastId();
    const r = await write("u3", "POST", `/tickets/${id}/handover`, { otp: "987654" });
    expect(r.statusCode).toBe(422);
    const [e, ...more] = await eventsSince(mark);
    expect(more).toEqual([]);
    expect(e).toMatchObject({
      action: "handover", target: id, outcome: "refused", status: 422,
      message: `That OTP does not match ${id}. Ask the collector to read it again.`, request: { body: { otp: MASK } },
    });
    expect(JSON.stringify(e)).not.toContain("987654");
  });

  it("an Idempotency-Key reused for a different request: the first write done, the second refused", async () => {
    const key = randomUUID();
    const mark = await lastId();
    expect((await write("u1", "PATCH", "/me", { ph: "91000 00009" }, key)).statusCode).toBe(200);
    const r = await write("u1", "PATCH", "/me", { ph: "92000 00009" }, key);
    expect(r.statusCode).toBe(409);
    const events = await eventsSince(mark);
    expect(events.map((e) => [e.action, e.outcome, e.status])).toEqual([["patchMe", "done", 200], ["patchMe", "refused", 409]]);
    expect(events[1].message).toBe("That Idempotency-Key was already used for a different request.");
  });

  it("a 401 leaves nothing: the client refreshes and retries, and the retry is the event", async () => {
    const mark = await lastId();
    const r = await app.inject({ method: "PATCH", url: "/api/v1/me", headers: { authorization: "Bearer not-a-token", "idempotency-key": randomUUID() }, payload: { ph: "94000 00009" } });
    expect(r.statusCode).toBe(401);
    expect(await eventsSince(mark)).toEqual([]);
  });

  it("a replay leaves nothing: the original is already logged", async () => {
    const key = randomUUID();
    const mark = await lastId();
    expect((await write("u6", "PATCH", "/me", { ph: "93000 00009" }, key)).statusCode).toBe(200);
    const again = await write("u6", "PATCH", "/me", { ph: "93000 00009" }, key);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    const events = await eventsSince(mark);
    expect(events.map((e) => [e.actor.id, e.outcome])).toEqual([["u6", "done"]]);
  });

  it("a refused edit: the before value the service kept before refusing", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-refused-edit", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => withTransaction(app.db, async () => {
      auditBefore({ ph: "75000 00007" });
      throw new RuleError("Refused - that number is already someone else's");
    })));
    try {
      const mark = await lastId();
      const r = await write("u1", "POST", "/__test/audit-refused-edit", undefined, randomUUID(), a);
      expect(r.statusCode).toBe(422);
      const [e, ...more] = await eventsSince(mark, a);
      expect(more).toEqual([]);
      expect(e).toMatchObject({ outcome: "refused", status: 422, before: { ph: "75000 00007" }, message: "Refused - that number is already someone else's" });
    } finally {
      await a.close();
    }
  });

  it("a 5xx: an error event carrying the sentence and its reference", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-boom", access: "any", response: OkResponseSchema });
    const a = await appWith((x) => mount(x, route, async () => { throw new Error("the disk is on fire"); }));
    try {
      const mark = await lastId();
      const r = await write("u1", "POST", "/__test/audit-boom", undefined, randomUUID(), a);
      expect(r.statusCode).toBe(500);
      const [e, ...more] = await eventsSince(mark, a);
      expect(more).toEqual([]);
      expect(e).toMatchObject({
        action: "POST /__test/audit-boom", outcome: "error", status: 500, cause: null,
        message: `Something went wrong on our side. Reference ${r.headers["x-request-id"]}.`,
      });
    } finally {
      await a.close();
    }
  });

  it("production's fallback: a write answered outside any transaction is logged done from what it sent", async () => {
    const route = defineRoute({ method: "POST", path: "/__test/audit-outside", access: "any", response: writeResponse(z.strictObject({ id: z.string() })) });
    const a = await appWith((x) => mount(x, route, async () => ({ result: { id: "OUT-1" }, changed: ["items" as const], message: "Staged outside any transaction" })), { NODE_ENV: "production" });
    try {
      const mark = await lastId();
      const r = await write("u2", "POST", "/__test/audit-outside", undefined, randomUUID(), a);
      expect(r.statusCode, r.body).toBe(200);
      const [e, ...more] = await eventsSince(mark, a);
      expect(more).toEqual([]);
      expect(e).toMatchObject({
        actor: { id: "u2" }, action: "POST /__test/audit-outside", target: "OUT-1", outcome: "done", status: 200,
        message: "Staged outside any transaction", changed: ["items"], result: { id: "OUT-1" },
      });
    } finally {
      await a.close();
    }
  });

  it("an event that cannot be stored is logged with its request id, and the reply is untouched", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const log: LogStream = { write: (s: string) => { for (const l of s.split("\n")) if (l) lines.push(JSON.parse(l) as Record<string, unknown>); } };
    const a = await appWith(() => undefined, { LOG_LEVEL: "error" }, log);
    await app.db.execute(sql.raw("alter table audit_outbox add constraint audit_outbox_refuse_ck check (false) not valid"));
    try {
      const r = await write("u1", "PUT", "/prices/A/juice", { price: 18 }, randomUUID(), a);
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("not_found");
      await a.auditSettled();
      expect(lines.find((l) => l.msg === "audit event not stored")).toMatchObject({ level: 50, action: "savePrice", requestId: r.headers["x-request-id"] });
    } finally {
      await app.db.execute(sql.raw("alter table audit_outbox drop constraint audit_outbox_refuse_ck"));
      await a.close();
    }
  });
});
