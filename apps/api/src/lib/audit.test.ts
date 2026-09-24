import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { asc, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AuditEvent } from "@rch/contract";
import { auditOutbox } from "../db/schema/index.js";
import { withTestSchema, type TestDb } from "../test/db.js";
import { seedTestDb } from "../test/seed.js";
import { AUDIT_OUTBOX_CHANNEL, MASK, SECRET_KEYS, actorOf, insertAuditEvent, maskSecrets, recordAuthEvent, recordSystemEvent, targetOf } from "./audit.js";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";

let t: TestDb;
let listener: Client;
/** Payloads of the notices this file's own outbox sent. The channel is database-wide and every
 *  other test file's writes notify on it too; the payload names the schema, so they are left out. */
let heard: string[] = [];

beforeAll(async () => {
  t = await withTestSchema("audit");
  await seedTestDb(t.db);
  listener = new Client({ connectionString: BASE });
  await listener.connect();
  listener.on("notification", (m) => { if (m.channel === AUDIT_OUTBOX_CHANNEL && m.payload === t.schemaName) heard.push(m.payload); });
  await listener.query(`listen "${AUDIT_OUTBOX_CHANNEL}"`);
});
afterAll(async () => { await listener.end(); await t.close(); });

/** NOTIFY is delivered asynchronously; give the listener socket a turn. */
const settle = () => new Promise((r) => setTimeout(r, 150));
const rows = () => t.db.select().from(auditOutbox).orderBy(asc(auditOutbox.id));

/** A complete, valid event - each case overrides only what it is about. */
const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  at: new Date().toISOString(), requestId: "req-audit-1",
  actor: { id: "u1", emp: "RC-4471", name: "Kavitha Raman", role: "Counter Operator", loc: "coffee" },
  action: "pay", method: "POST", path: "/bills", target: "CF/1188", targetLoc: "coffee",
  outcome: "done", status: 200, message: "Bill CF/1188 · ₹20.00 collected at Coffee Shop", cause: null,
  request: { params: {}, query: {}, body: { loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 1 }] } },
  before: null, result: { no: "CF/1188", loc: "coffee" }, changed: ["stock", "bills"],
  ip: "127.0.0.1", userAgent: "vitest", ...over,
});

describe("maskSecrets", () => {
  it("masks every secret key at any depth", () => {
    const sent = {
      body: { password: "hunter2222", newPassword: "n3w-pass-word", currentPassword: "old-pass-word", tempPassword: "Temp-1234", name: "Anitha R" },
      lines: [{ otp: "123456", qty: 2 }],
      session: { token: "t", accessToken: "at", refreshToken: "rt", secret: { nested: "still a secret" } },
    };
    expect(maskSecrets(sent)).toEqual({
      body: { password: MASK, newPassword: MASK, currentPassword: MASK, tempPassword: MASK, name: "Anitha R" },
      lines: [{ otp: MASK, qty: 2 }],
      session: { token: MASK, accessToken: MASK, refreshToken: MASK, secret: MASK },
    });
    // A copy: the request object Fastify still holds is not rewritten under it.
    expect(sent.body.password).toBe("hunter2222");
  });

  it("matches names exactly, so a field that only mentions a secret stays readable", () => {
    expect(maskSecrets({ mustChangePassword: true, OTP: "x", otpAttempts: 2, clientSecret: "y", current: "c", next: "n" }))
      .toEqual({ mustChangePassword: true, OTP: "x", otpAttempts: 2, clientSecret: "y", current: "c", next: "n" });
    expect([...SECRET_KEYS].sort()).toEqual(["accessToken", "currentPassword", "newPassword", "otp", "password", "refreshToken", "secret", "tempPassword", "token"]);
  });

  it("leaves every non-object as it is", () => {
    expect(maskSecrets("otp")).toBe("otp");
    expect(maskSecrets(42)).toBe(42);
    expect(maskSecrets(null)).toBeNull();
    const at = new Date("2026-09-14T04:30:00.000Z");
    expect(maskSecrets({ at })).toEqual({ at });
  });
});

describe("targetOf", () => {
  it("names one document by its id, its number or its key, from the path or the result", () => {
    expect(targetOf("approveRequest", { id: "REQ-2026-0911" }, { appr: [12], note: "" }, { request: {}, trimmed: false })).toEqual({ target: "REQ-2026-0911", targetLoc: "" });
    expect(targetOf("voidBill", { no: "CF/1188" }, { reason: "Wrong item" }, { no: "CF/1188", loc: "coffee" })).toEqual({ target: "CF/1188", targetLoc: "coffee" });
    expect(targetOf("patchItem", { it: "juice" }, { cost: 14 }, { key: "juice", item: {} })).toEqual({ target: "juice", targetLoc: "" });
    expect(targetOf("pay", {}, { loc: "coffee" }, { no: "CF/1189", loc: "coffee" })).toEqual({ target: "CF/1189", targetLoc: "coffee" });
    expect(targetOf("createRequest", {}, { lines: [] }, { id: "REQ-2026-0913", from: "coffee" })).toEqual({ target: "REQ-2026-0913", targetLoc: "coffee" });
    expect(targetOf("createItem", {}, { name: "Masala Tea" }, { key: "tea2", item: {} })).toEqual({ target: "tea2", targetLoc: "" });
    expect(targetOf("transfer", {}, { from: "coffee", to: "kiosk" }, { id: "TKT-0801", from: "coffee", to: "kiosk" })).toEqual({ target: "TKT-0801", targetLoc: "coffee" });
    // What the request named wins over anything the result carries.
    expect(targetOf("createProdOrder", {}, { from: "rest", lines: [] }, { id: "PORD-0101", loc: "kiosk", from: "kiosk" })).toEqual({ target: "PORD-0101", targetLoc: "rest" });
  });

  it("names a cell where one field alone would be ambiguous", () => {
    expect(targetOf("savePrice", { list: "A", it: "juice" }, { price: 19 }, { list: "A", it: "juice", price: 19 })).toEqual({ target: "A:juice", targetLoc: "" });
    expect(targetOf("addMenuItem", { loc: "rest" }, { it: "tea" }, { loc: "rest", items: ["tea"] })).toEqual({ target: "rest:tea", targetLoc: "rest" });
    expect(targetOf("removeMenuItem", { loc: "rest", it: "tea" }, undefined, null)).toEqual({ target: "rest:tea", targetLoc: "rest" });
    expect(targetOf("toggleAvail", {}, { loc: "coffee", it: "juice" }, null)).toEqual({ target: "coffee:juice", targetLoc: "coffee" });
    expect(targetOf("updatePoLine", { id: "PO-2026-0102", n: 0 }, { qty: 4 }, null)).toEqual({ target: "PO-2026-0102#0", targetLoc: "" });
    expect(targetOf("removePoLine", { id: "PO-2026-0102", n: "1" }, undefined, null)).toEqual({ target: "PO-2026-0102#1", targetLoc: "" });
  });

  it("says nothing rather than something wrong when a refusal left only half the request", () => {
    expect(targetOf("addMenuItem", { loc: "rest" }, "not json", null)).toEqual({ target: "rest", targetLoc: "rest" });
    expect(targetOf("createRequest", {}, null, null)).toEqual({ target: "", targetLoc: "" });
    expect(targetOf("cancelTicket", { id: { nested: true } }, null, null)).toEqual({ target: "", targetLoc: "" });
  });
});

describe("actorOf", () => {
  it("keeps the account as it stands: number, name, role label and location", async () => {
    expect(await actorOf(t.db, "u1")).toEqual({ id: "u1", emp: "RC-4471", name: "Kavitha Raman", role: "Counter Operator", loc: "coffee" });
  });
  it("calls the super admin what the wire calls it, and puts it at no desk", async () => {
    expect(await actorOf(t.db, "u7")).toEqual({ id: "u7", emp: "RC-0001", name: "System Administrator", role: "Super Admin", loc: "" });
  });
  it("keeps what the caller typed when there is no account behind it, capped at 64", async () => {
    expect(await actorOf(t.db, null, "RC-9999")).toEqual({ id: null, emp: "RC-9999", name: "", role: "", loc: "" });
    expect((await actorOf(t.db, null, "x".repeat(80))).emp).toHaveLength(64);
    expect(await actorOf(t.db, null)).toEqual({ id: null, emp: "", name: "", role: "", loc: "" });
  });
  it("keeps the id of an account deleted while its token was still live", async () => {
    expect(await actorOf(t.db, "u404")).toEqual({ id: "u404", emp: "", name: "", role: "", loc: "" });
  });
});

describe("insertAuditEvent", () => {
  it("stores the event and wakes the drainer once the transaction commits", async () => {
    heard = [];
    const before = (await rows()).length;
    const e = event();
    await t.db.transaction(async (tx) => { await insertAuditEvent(tx, e); });
    await settle();
    const after = await rows();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.event).toEqual(e);
    expect(after.at(-1)!.at.toISOString()).toBe(e.at);
    expect(heard).toEqual([t.schemaName]);
  });

  it("stores nothing and wakes nobody when the transaction rolls back", async () => {
    heard = [];
    const before = (await rows()).length;
    await expect(t.db.transaction(async (tx) => {
      await insertAuditEvent(tx, event({ requestId: "req-rolled-back" }));
      throw new Error("the rule refused");
    })).rejects.toThrow("the rule refused");
    await settle();
    expect(await rows()).toHaveLength(before);
    expect(heard).toEqual([]);
  });

  it("stores on the pool too, for an event no transaction carries", async () => {
    heard = [];
    await insertAuditEvent(t.db, event({ outcome: "refused", status: 422, message: "Refused - printed MRP of ₹20 is a hard ceiling for Real Juice 200ml", result: null, changed: [] }));
    await settle();
    expect((await rows()).at(-1)!.event).toMatchObject({ outcome: "refused", status: 422, result: null });
    expect(heard).toHaveLength(1);
  });

  it("is refused at the database if anything tries to rewrite a stored event", async () => {
    await insertAuditEvent(t.db, event({ requestId: "req-kept-as-written" }));
    const refusal = await t.db.execute(sql`update audit_outbox set event = '{}'::jsonb`).then(
      () => "it was allowed",
      (e: { cause?: Error }) => String(e.cause?.message),
    );
    expect(refusal).toBe("audit_outbox rows are never updated; the audit service moves each one as it was written");
  });

  it("refuses an event the drainer would dead-letter, before anything is written", async () => {
    const before = (await rows()).length;
    await expect(insertAuditEvent(t.db, event({ action: "" }))).rejects.toThrow();
    await expect(insertAuditEvent(t.db, event({ at: "14-Sep-2026 10:30" }))).rejects.toThrow();
    expect(await rows()).toHaveLength(before);
  });
});

describe("recordAuthEvent", () => {
  /** What Fastify hands the auth routes, cut down to what an event reads. */
  const request = (body: unknown): FastifyRequest => ({
    id: "req-auth-1", ip: "10.0.0.7", method: "POST", url: "/api/v1/auth/login", routeOptions: { url: "/api/v1/auth/login" },
    headers: { "user-agent": "vitest" }, params: {}, query: {}, body,
  }) as unknown as FastifyRequest;

  it("stores a refused sign-in with the number that was typed, and never the body it came in", async () => {
    await recordAuthEvent(t.db, request({ emp: "RC-9999", password: "hunter2222" }), {
      action: "login", outcome: "refused", status: 401, message: "That employee id and password do not match.", cause: "no such employee", actorId: null, typedEmp: "RC-9999",
    });
    const stored = (await rows()).at(-1)!.event;
    expect(stored).toEqual({
      at: expect.any(String), requestId: "req-auth-1",
      actor: { id: null, emp: "RC-9999", name: "", role: "", loc: "" },
      action: "login", method: "POST", path: "/auth/login", target: "", targetLoc: "",
      outcome: "refused", status: 401, message: "That employee id and password do not match.", cause: "no such employee",
      request: { params: {}, query: {} }, before: null, result: null, changed: [], ip: "10.0.0.7", userAgent: "vitest",
    });
    expect(JSON.stringify(stored)).not.toContain("hunter2222");
  });

  it("stores the request the auth module names instead, masked, against the account", async () => {
    await recordAuthEvent(t.db, request({}), {
      action: "login", outcome: "done", status: 200, message: "Signed in", actorId: "u1", request: { body: { emp: "RC-4471", password: "changeme" } },
    });
    expect((await rows()).at(-1)!.event).toMatchObject({
      actor: { id: "u1", emp: "RC-4471", name: "Kavitha Raman" }, outcome: "done", cause: null,
      request: { body: { emp: "RC-4471", password: MASK } },
    });
  });
});

describe("recordSystemEvent", () => {
  it("stores a done event with the QR Orders account as the actor, creating it if nobody has yet, masked", async () => {
    await t.db.transaction(async (tx) => {
      await recordSystemEvent(tx, {
        action: "createQrOrder", subject: "QO-2026-0001", loc: "coffee", method: "POST", path: "/public/qr/:token/orders",
        request: { params: { token: "abcdefghijklmnopqrstuvwx" }, body: { name: "Asha", phone: "9876543210" } },
        result: { order: { id: "QO-2026-0001" }, secret: "s".repeat(43) },
        message: "QR order QO-2026-0001 placed at Coffee Shop", changed: ["qrOrders"], ip: "10.0.0.9", device: "x".repeat(600),
      });
    });
    const stored = (await rows()).at(-1)!.event as AuditEvent;
    expect(stored).toMatchObject({
      actor: { id: "sys-qr", emp: "SYS-QR", name: "QR Orders", role: "System", loc: "" },
      action: "createQrOrder", method: "POST", path: "/public/qr/:token/orders", target: "QO-2026-0001", targetLoc: "coffee",
      outcome: "done", status: 200, cause: null, before: null, changed: ["qrOrders"], ip: "10.0.0.9",
      request: { params: { token: MASK } }, result: { secret: MASK },
    });
    expect(stored.userAgent).toHaveLength(512);
    expect(stored.requestId).toMatch(/^system-[0-9a-f-]{36}$/);
  });
  it("records a worker's own step with no route, and rolls back with the transaction it is in", async () => {
    await t.db.transaction(async (tx) => {
      await recordSystemEvent(tx, { action: "qrRefundSent", subject: "QO-2026-0001-R1", message: "Refund QO-2026-0001-R1 sent", requestId: "worker-1" });
    });
    expect((await rows()).at(-1)!.event).toMatchObject({
      action: "qrRefundSent", method: "", path: "", targetLoc: "", request: null, result: null, changed: [], ip: "", userAgent: "", requestId: "worker-1",
    });
    const before = (await rows()).length;
    await expect(t.db.transaction(async (tx) => {
      await recordSystemEvent(tx, { action: "qrRefundFailed", subject: "QO-2026-0001-R1", message: "Refund failed" });
      throw new Error("the worker's write failed");
    })).rejects.toThrow("the worker's write failed");
    expect(await rows()).toHaveLength(before);
  });
});
