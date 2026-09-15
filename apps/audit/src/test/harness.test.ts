import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVerifier } from "fast-jwt";
import { AuditEventSchema } from "@rch/contract";
import { buildTestApp, putOutbox, sampleEvent, signToken } from "./app.js";

const verifierFor = (key: string) => createVerifier({ key, algorithms: ["EdDSA"], allowedIss: "rch-api" });

let app: Awaited<ReturnType<typeof buildTestApp>>;
beforeAll(async () => { app = await buildTestApp({ schema: "harness", drainer: false }); await app.ready(); });
afterAll(async () => { await app.close(); });

describe("buildTestApp", () => {
  it("points the app at its own schema pair, with the events channel on the outbox schema", () => {
    expect(app.config.auditSchema).toBe(app.testDb.auditSchema);
    expect(app.config.outboxSchema).toBe(app.testDb.outboxSchema);
    expect(app.config.eventsSchema).toBe(app.testDb.outboxSchema);
    expect(app.testDb.outboxSchema).toBe(`t_audit_harness_${process.pid}`);
    expect(app.db).toBe(app.testDb.db);
  });

  it("signs tokens the way the API does, with the current key or the previous one", () => {
    const claims = { sub: "u9", role: "manager", loc: "rest", admin: true };
    const current = verifierFor(app.config.jwtPublicKeyPem)(signToken(app, claims));
    expect(current).toMatchObject({ sub: "u9", role: "manager", loc: "rest", admin: true, mcp: false, iss: "rch-api" });
    expect(current.exp - current.iat).toBe(15 * 60);
    const previous = signToken(app, claims, { previousKey: true });
    expect(() => verifierFor(app.config.jwtPublicKeyPem)(previous)).toThrow();
    expect(verifierFor(app.config.jwtPreviousPublicKeyPem!)(previous)).toMatchObject({ sub: "u9" });
  });

  it("puts outbox rows in the order given, and sampleEvent is a valid event", async () => {
    expect(AuditEventSchema.safeParse(sampleEvent()).success).toBe(true);
    expect(sampleEvent({ outcome: "refused", status: 422 })).toMatchObject({ outcome: "refused", status: 422, action: "voidBill" });
    await putOutbox(app.testDb, [sampleEvent({ requestId: "a" }), { not: "an event" }, sampleEvent({ requestId: "c" })]);
    const r = await app.testDb.pool.query(`select event from "${app.testDb.outboxSchema}".audit_outbox order by id`);
    expect(r.rows.map((x: { event: { requestId?: string } }) => x.event.requestId)).toEqual(["a", undefined, "c"]);
  });

  it("builds the outbox with the API's refusal of every UPDATE", async () => {
    await putOutbox(app.testDb, [sampleEvent()]);
    await expect(app.testDb.pool.query(`update "${app.testDb.outboxSchema}".audit_outbox set at = now()`)).rejects.toThrow("audit_outbox rows are never updated; the audit service moves each one as it was written");
  });

  it("drops its schemas when the app closes", async () => {
    const other = await buildTestApp({ schema: "harness_close", drainer: false });
    const { outboxSchema, auditSchema } = other.testDb;
    await other.close();
    const r = await app.testDb.pool.query("select nspname from pg_namespace where nspname = any($1)", [[outboxSchema, auditSchema, `${auditSchema}_drizzle`]]);
    expect(r.rows).toEqual([]);
  });
});
