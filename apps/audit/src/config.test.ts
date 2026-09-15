import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";
import { testKeyPair } from "./test/config.js";

const key = testKeyPair().publicKeyB64;
const good = { NODE_ENV: "test", AUDIT_DATABASE_URL: "postgres://rch_audit:pw@db:5432/rch", JWT_PUBLIC_KEY: key } as const;

/** The ConfigError's text for `env`, or "" when it loads. */
function refusal(env: NodeJS.ProcessEnv): string {
  try { loadConfig(env); return ""; } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
}

describe("loadConfig", () => {
  it("applies the service's defaults", () => {
    const c = loadConfig(good);
    expect(c.env).toBe("test");
    expect(c.port).toBe(3100);
    expect(c.logLevel).toBe("info");
    expect(c.databaseUrl).toBe(good.AUDIT_DATABASE_URL);
    // Unset, the migrate CLI connects as the runtime user - which is also what tells it to skip role setup.
    expect(c.migrateDatabaseUrl).toBe(good.AUDIT_DATABASE_URL);
    expect(c.databaseSsl).toBe(false);
    expect(c.dbPoolMax).toBe(5);
    expect(c.jwtPublicKeyPem).toContain("-----BEGIN PUBLIC KEY-----");
    expect(c.jwtPreviousPublicKeyPem).toBeUndefined();
    expect(c.auditSchema).toBe("audit");
    expect(c.eventsSchema).toBe("public");
    expect(c.outboxSchema).toBe("public");
    expect(c.drainBatch).toBe(500);
    expect(c.drainPollMs).toBe(5000);
    const oneHop = c.trustProxy as (address: string, hop: number) => boolean;
    expect(typeof oneHop).toBe("function");
    expect(oneHop("1.2.3.4", 0)).toBe(true);
    expect(oneHop("1.2.3.4", 1)).toBe(false);
  });

  it("takes a separate migrate URL and a previous key, and reads a blank previous key as none", () => {
    const previous = testKeyPair().publicKeyB64;
    const c = loadConfig({ ...good, MIGRATE_DATABASE_URL: "postgres://rch:rch@db:5432/rch", JWT_PREVIOUS_PUBLIC_KEY: previous });
    expect(c.migrateDatabaseUrl).toBe("postgres://rch:rch@db:5432/rch");
    expect(c.jwtPreviousPublicKeyPem).toBe(Buffer.from(previous, "base64").toString("utf8"));
    expect(loadConfig({ ...good, JWT_PREVIOUS_PUBLIC_KEY: "" }).jwtPreviousPublicKeyPem).toBeUndefined();
  });

  it("turns TLS on by default only in production, and lets DATABASE_SSL overrule that both ways", () => {
    expect(loadConfig({ ...good, NODE_ENV: "production" }).databaseSsl).toBe(true);
    expect(loadConfig({ ...good, NODE_ENV: "production", DATABASE_SSL: "false" }).databaseSsl).toBe(false);
    expect(loadConfig({ ...good, DATABASE_SSL: "true" }).databaseSsl).toBe(true);
  });

  it("parses TRUST_PROXY the way the API does", () => {
    expect(loadConfig({ ...good, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ ...good, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    const twoHops = loadConfig({ ...good, TRUST_PROXY: "2" }).trustProxy as (address: string, hop: number) => boolean;
    expect(twoHops("1.2.3.4", 1)).toBe(true);
    expect(twoHops("1.2.3.4", 2)).toBe(false);
    expect(loadConfig({ ...good, TRUST_PROXY: "10.0.0.0/8" }).trustProxy).toBe("10.0.0.0/8");
  });

  it("names every missing or malformed variable at once", () => {
    const msg = refusal({ NODE_ENV: "test", JWT_PUBLIC_KEY: "eA==", PORT: "abc" });
    expect(msg).toContain("AUDIT_DATABASE_URL");
    expect(msg).toContain("JWT_PUBLIC_KEY: must be a base64-encoded PEM public key");
    expect(msg).toContain("PORT");
  });

  it("accepts only plain lower-case schema names that fit beside their suffix", () => {
    for (const bad of ["Audit", 'audit"; drop schema public cascade; --', "1audit", "pg_audit", "audit-log", "a".repeat(56)]) {
      expect(refusal({ ...good, AUDIT_SCHEMA: bad }), bad).toContain("AUDIT_SCHEMA");
    }
    expect(loadConfig({ ...good, AUDIT_SCHEMA: "a".repeat(55) }).auditSchema).toHaveLength(55);
    expect(loadConfig({ ...good, OUTBOX_SCHEMA: "o".repeat(63) }).outboxSchema).toHaveLength(63);
    expect(refusal({ ...good, OUTBOX_SCHEMA: "o".repeat(64) })).toContain("OUTBOX_SCHEMA");
    expect(loadConfig({ ...good, EVENTS_SCHEMA: "e".repeat(52) }).eventsSchema).toHaveLength(52);
    expect(refusal({ ...good, EVENTS_SCHEMA: "e".repeat(53) })).toContain("EVENTS_SCHEMA");
  });

  it("refuses an audit schema that is not a schema of its own", () => {
    expect(refusal({ ...good, AUDIT_SCHEMA: "public" })).toContain("AUDIT_SCHEMA: must be a schema of its own");
    expect(refusal({ ...good, AUDIT_SCHEMA: "t_x", OUTBOX_SCHEMA: "t_x", EVENTS_SCHEMA: "t_y" })).toContain("AUDIT_SCHEMA");
    expect(refusal({ ...good, AUDIT_SCHEMA: "t_x", OUTBOX_SCHEMA: "t_y", EVENTS_SCHEMA: "t_x" })).toContain("AUDIT_SCHEMA");
  });

  it("bounds the pool, the drain batch and the poll interval", () => {
    expect(loadConfig({ ...good, DB_POOL_MAX: "12", DRAIN_BATCH: "100", DRAIN_POLL_MS: "250" })).toMatchObject({ dbPoolMax: 12, drainBatch: 100, drainPollMs: 250 });
    expect(refusal({ ...good, DB_POOL_MAX: "0" })).toContain("DB_POOL_MAX");
    expect(refusal({ ...good, DRAIN_BATCH: "0" })).toContain("DRAIN_BATCH");
    expect(refusal({ ...good, DRAIN_BATCH: "5001" })).toContain("DRAIN_BATCH");
    expect(refusal({ ...good, DRAIN_POLL_MS: "50" })).toContain("DRAIN_POLL_MS");
    expect(refusal({ ...good, DRAIN_POLL_MS: "25001" })).toContain("DRAIN_POLL_MS");
  });
});
