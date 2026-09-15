import { describe, expect, it } from "vitest";
import { cliDatabaseUrl, ConfigError, loadConfig } from "./config.js";

const good = {
  NODE_ENV: "test", PORT: "3000", DATABASE_URL: "postgres://u:p@h:5432/d",
  JWT_PRIVATE_KEY: "eA==", JWT_PUBLIC_KEY: "eA==", CORS_ORIGIN: "http://localhost:5173",
  SEED_PASSWORD: "changeme-local-1",
};

describe("loadConfig", () => {
  it("parses a complete environment with defaults applied", () => {
    const c = loadConfig(good);
    expect(c.port).toBe(3000);
    expect(c.accessTokenTtl).toBe("15m");
    expect(c.refreshTokenTtlDays).toBe(30);
    expect(c.rateLimitPerMinute).toBe(300);
    expect(c.loginRateLimitPerMinute).toBe(10);
    expect(c.loginRateLimitPerEmpPerMinute).toBe(5);
    // One pod's share of the instance's connections. A request takes exactly one of them
    // (`withReadTransaction`, lib/db.ts), so this is "how many requests at once" - the default
    // is what the chart ships and what the load check was measured against.
    expect(c.dbPoolMax).toBe(10);
    // The heartbeat has to sit under every idle timer on the path (nginx 3600s, the ALB's
    // 3600s) and comfortably under a browser's own patience; the retry hint is what a
    // dropped stream waits before coming back.
    expect(c.sseHeartbeatMs).toBe(25_000);
    expect(c.sseRetryMs).toBe(1000);
    // Default TRUST_PROXY="1": a one-hop trust function, not a bare number (Fastify 5 no-ops
    // a raw number for security - see parseTrustProxy's comment in config.ts).
    expect(typeof c.trustProxy).toBe("function");
    const oneHop = c.trustProxy as (address: string, hop: number) => boolean;
    expect(oneHop("1.2.3.4", 0)).toBe(true);
    expect(oneHop("1.2.3.4", 1)).toBe(false);
    expect(c.corsOrigins).toEqual(["http://localhost:5173"]);
  });
  it("parses TRUST_PROXY into what Fastify expects", () => {
    expect(loadConfig({ ...good, TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ ...good, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    const twoHops = loadConfig({ ...good, TRUST_PROXY: "2" }).trustProxy as (address: string, hop: number) => boolean;
    expect(typeof twoHops).toBe("function");
    expect(twoHops("1.2.3.4", 0)).toBe(true);
    expect(twoHops("1.2.3.4", 1)).toBe(true);
    expect(twoHops("1.2.3.4", 2)).toBe(false);
    expect(loadConfig({ ...good, TRUST_PROXY: "10.0.0.0/8" }).trustProxy).toBe("10.0.0.0/8");
  });
  it("names every missing or malformed variable at once", () => {
    const bad = { ...good, DATABASE_URL: "not-a-url", JWT_PUBLIC_KEY: undefined, PORT: "abc" };
    expect(() => loadConfig(bad)).toThrow(ConfigError);
    try { loadConfig(bad); } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain("DATABASE_URL");
      expect(msg).toContain("JWT_PUBLIC_KEY");
      expect(msg).toContain("PORT");
    }
  });
  it("takes a pool size from the environment, and refuses a nonsensical one", () => {
    expect(loadConfig({ ...good, DB_POOL_MAX: "25" }).dbPoolMax).toBe(25);
    expect(() => loadConfig({ ...good, DB_POOL_MAX: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, DB_POOL_MAX: "lots" })).toThrow(ConfigError);
  });
  it("refuses to start without a seed password, and names the variable", () => {
    // There is no default any more: a published one is the same password on every host that
    // ever ran the seed, and `changePassword` is reachable with a must-change token, so a
    // takeover through a seeded account is permanent.
    const { SEED_PASSWORD: _omitted, ...without } = good;
    expect(() => loadConfig(without)).toThrow(ConfigError);
    try { loadConfig(without); } catch (e) { expect(String((e as Error).message)).toContain("SEED_PASSWORD"); }
  });
  it("refuses a seed password short enough to be guessed", () => {
    expect(() => loadConfig({ ...good, SEED_PASSWORD: "changeme" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, SEED_PASSWORD: "elevenchars" })).toThrow(ConfigError);
    expect(loadConfig({ ...good, SEED_PASSWORD: "twelve-chars" }).seedPassword).toBe("twelve-chars");
  });
  it("turns TLS on by itself in production, and leaves the choice alone everywhere else", () => {
    const prodImages = { IMAGE_STORE: "s3", IMAGE_BUCKET: "b-1", AWS_REGION: "ap-south-1" };
    expect(loadConfig({ ...good, ...prodImages, NODE_ENV: "production" }).databaseSsl).toBe(true);
    expect(loadConfig({ ...good, ...prodImages, NODE_ENV: "production", DATABASE_SSL: "false" }).databaseSsl).toBe(false);
    expect(loadConfig({ ...good, NODE_ENV: "development" }).databaseSsl).toBe(false);
    expect(loadConfig({ ...good, NODE_ENV: "development", DATABASE_SSL: "true" }).databaseSsl).toBe(true);
  });
  it("splits a comma-separated CORS list", () => {
    expect(loadConfig({ ...good, CORS_ORIGIN: "https://a.example, https://b.example" }).corsOrigins)
      .toEqual(["https://a.example", "https://b.example"]);
  });
  it("gives the operator CLIs MIGRATE_DATABASE_URL, and DATABASE_URL where there is none", () => {
    const one = loadConfig(good);
    expect(one.migrateDatabaseUrl).toBeUndefined();
    expect(cliDatabaseUrl(one)).toBe("postgres://u:p@h:5432/d");
    const two = loadConfig({ ...good, MIGRATE_DATABASE_URL: "postgres://rch:owner@h:5432/d" });
    expect(two.migrateDatabaseUrl).toBe("postgres://rch:owner@h:5432/d");
    expect(two.databaseUrl).toBe("postgres://u:p@h:5432/d");
    expect(cliDatabaseUrl(two)).toBe("postgres://rch:owner@h:5432/d");
    expect(() => loadConfig({ ...good, MIGRATE_DATABASE_URL: "mysql://rch:owner@h/d" })).toThrow(ConfigError);
  });

  // ---- item photos ----
  it("keeps photos in a local folder unless told otherwise", () => {
    expect(loadConfig(good).images).toEqual({ store: "disk", dir: ".data/images" });
    expect(loadConfig({ ...good, IMAGE_DIR: "/tmp/x" }).images).toEqual({ store: "disk", dir: "/tmp/x" });
  });
  it("reads the bucket and region for S3, and refuses S3 without either", () => {
    expect(loadConfig({ ...good, IMAGE_STORE: "s3", IMAGE_BUCKET: "rch-images", AWS_REGION: "ap-south-1" }).images)
      .toEqual({ store: "s3", bucket: "rch-images", region: "ap-south-1" });
    expect(() => loadConfig({ ...good, IMAGE_STORE: "s3", AWS_REGION: "ap-south-1" })).toThrow(/IMAGE_BUCKET/);
    expect(() => loadConfig({ ...good, IMAGE_STORE: "s3", IMAGE_BUCKET: "rch-images" })).toThrow(/AWS_REGION/);
  });
  it("refuses a production process that would keep photos on its own disk", () => {
    expect(() => loadConfig({ ...good, NODE_ENV: "production" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, NODE_ENV: "production" })).toThrow(/IMAGE_STORE/);
    expect(loadConfig({ ...good, NODE_ENV: "production", IMAGE_STORE: "s3", IMAGE_BUCKET: "b-1", AWS_REGION: "ap-south-1" }).images.store).toBe("s3");
  });
});
