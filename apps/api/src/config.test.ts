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
    expect(c.corsOrigins).toEqual(["http://localhost:5173"]);
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
