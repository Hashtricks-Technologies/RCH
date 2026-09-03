import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const good = {
  NODE_ENV: "test", PORT: "3000", DATABASE_URL: "postgres://u:p@h:5432/d",
  JWT_PRIVATE_KEY: "eA==", JWT_PUBLIC_KEY: "eA==", CORS_ORIGIN: "http://localhost:5173",
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
  it("splits a comma-separated CORS list", () => {
    expect(loadConfig({ ...good, CORS_ORIGIN: "https://a.example, https://b.example" }).corsOrigins)
      .toEqual(["https://a.example", "https://b.example"]);
  });
});
