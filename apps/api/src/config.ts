import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(0, 65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.url().startsWith("postgres"),
  TEST_DATABASE_URL: z.url().startsWith("postgres").optional(),
  DATABASE_SSL: bool.default(false),
  CORS_ORIGIN: z.string().min(1),
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  JWT_PREVIOUS_PUBLIC_KEY: z.string().optional(),
  ACCESS_TOKEN_TTL: z.string().regex(/^\d+[smhd]$/).default("15m"),
  REFRESH_TOKEN_TTL_DAYS: int(1, 365).default(30),
  COOKIE_SECURE: bool.default(true),
  SEED_PASSWORD: z.string().min(8).default("changeme"),
  SEED_FORCE_PASSWORD_CHANGE: bool.default(true),
  RATE_LIMIT_PER_MINUTE: int(10, 100_000).default(300),
  LOGIN_RATE_LIMIT_PER_MINUTE: int(1, 1000).default(10),
});

export class ConfigError extends Error {}

export type Config = Readonly<{
  env: "development" | "test" | "production";
  port: number;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  databaseUrl: string;
  testDatabaseUrl?: string;
  databaseSsl: boolean;
  corsOrigins: string[];
  jwt: { privateKeyPem: string; publicKeyPem: string; previousPublicKeyPem?: string };
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
  cookieSecure: boolean;
  seedPassword: string;
  seedForcePasswordChange: boolean;
  rateLimitPerMinute: number;
  loginRateLimitPerMinute: number;
}>;

const pem = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const r = Env.safeParse(env);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Invalid environment:\n${lines.join("\n")}`);
  }
  const e = r.data;
  return Object.freeze({
    env: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    testDatabaseUrl: e.TEST_DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    corsOrigins: e.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
    jwt: {
      privateKeyPem: pem(e.JWT_PRIVATE_KEY),
      publicKeyPem: pem(e.JWT_PUBLIC_KEY),
      previousPublicKeyPem: e.JWT_PREVIOUS_PUBLIC_KEY ? pem(e.JWT_PREVIOUS_PUBLIC_KEY) : undefined,
    },
    accessTokenTtl: e.ACCESS_TOKEN_TTL,
    refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    cookieSecure: e.COOKIE_SECURE,
    seedPassword: e.SEED_PASSWORD,
    seedForcePasswordChange: e.SEED_FORCE_PASSWORD_CHANGE,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    loginRateLimitPerMinute: e.LOGIN_RATE_LIMIT_PER_MINUTE,
  });
}
