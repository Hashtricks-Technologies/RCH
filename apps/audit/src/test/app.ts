import { createSigner } from "fast-jwt";
import type { AuditEvent } from "@rch/contract";
import { buildApp, type AuditApp } from "../app.js";
import { testConfig, testKeyPair } from "./config.js";
import { withAuditSchema, type AuditTestDb } from "./db.js";

export type { AuditTestDb } from "./db.js";
export { putOutbox } from "./db.js";

/** The private halves of the pairs whose public keys a test app was configured with. */
const signingKeys = new WeakMap<AuditApp, { current: string; previous: string }>();

/**
 * An app on its own schema pair (`src/test/db.ts`), with EVENTS_SCHEMA set to the outbox schema -
 * the schema a test's API would be running in - and two fresh Ed25519 pairs: JWT_PUBLIC_KEY and
 * JWT_PREVIOUS_PUBLIC_KEY, whose private halves `signToken` signs with. `env` overrides any of it.
 * Closing the app drops the schemas.
 */
export async function buildTestApp(opts: { schema: string; drainer?: boolean; env?: Partial<NodeJS.ProcessEnv> }): Promise<AuditApp & { testDb: AuditTestDb }> {
  const current = testKeyPair();
  const previous = testKeyPair();
  const testDb = await withAuditSchema(opts.schema);
  let app: AuditApp;
  try {
    const config = testConfig({
      AUDIT_SCHEMA: testDb.auditSchema,
      OUTBOX_SCHEMA: testDb.outboxSchema,
      EVENTS_SCHEMA: testDb.outboxSchema,
      JWT_PUBLIC_KEY: current.publicKeyB64,
      JWT_PREVIOUS_PUBLIC_KEY: previous.publicKeyB64,
      ...opts.env,
    });
    app = await buildApp(config, { db: testDb.db, pool: testDb.pool, searchPath: testDb.auditSchema, drainer: opts.drainer, cleanup: testDb.close });
  } catch (e) {
    await testDb.close();
    throw e;
  }
  signingKeys.set(app, { current: current.privateKeyPem, previous: previous.privateKeyPem });
  return Object.assign(app, { testDb });
}

/** An access token shaped exactly like the API's `signAccess` (EdDSA, `iss: "rch-api"`, 15 min),
 *  signed with the app's current key or, with `previousKey`, the rotated-out one. */
export function signToken(app: AuditApp, claims: { sub: string; role: string; loc: string; admin: boolean; mcp?: boolean }, opts: { previousKey?: boolean } = {}): string {
  const keys = signingKeys.get(app);
  if (!keys) throw new Error("signToken needs an app built by buildTestApp.");
  const sign = createSigner({ key: opts.previousKey ? keys.previous : keys.current, algorithm: "EdDSA", iss: "rch-api", expiresIn: "15m" });
  return sign({ sub: claims.sub, role: claims.role, loc: claims.loc, mcp: claims.mcp ?? false, admin: claims.admin });
}

/** A valid event: the manager voiding a bill. Override any field; the result is not re-parsed,
 *  so a test after a dead letter builds its own broken object instead. */
export const sampleEvent = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  at: "2026-09-14T04:30:00.000Z",
  requestId: "req-sample-1",
  actor: { id: "u2", emp: "RC-3120", name: "Ramesh Kumar", role: "Outlet Manager", loc: "rest" },
  action: "voidBill",
  method: "POST",
  path: "/bills/:no/void",
  target: "B-0001",
  targetLoc: "coffee",
  outcome: "done",
  status: 200,
  message: "Bill B-0001 voided.",
  cause: null,
  request: { params: { no: "B-0001" }, query: {}, body: { reason: "Billed to the wrong payer" } },
  before: null,
  result: { no: "B-0001", voided: true },
  changed: ["bills", "stock"],
  ip: "10.0.0.7",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  ...over,
});
