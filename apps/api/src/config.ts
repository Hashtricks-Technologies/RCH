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
  /** Connections this process's pool may hold. Ten is what one pod is sized for (RDS's own
   *  `max_connections` divided across the replicas, with room for the SSE listener and a CLI);
   *  a request takes exactly one of them, so raise it only with a bigger instance behind it. */
  DB_POOL_MAX: int(1, 200).default(10),
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
  LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE: int(1, 1000).default(5),
  SSE_HEARTBEAT_MS: int(10, 300_000).default(25_000),
  SSE_RETRY_MS: int(100, 60_000).default(1000),
  /** "true"/"false", a hop count ("1", "2", …, translated to an equivalent trust function —
   *  see `parseTrustProxy`), or a raw CIDR/IP (list) handed straight to `proxy-addr`. */
  TRUST_PROXY: z.string().min(1).default("1"),
});

export class ConfigError extends Error {}

export type Config = Readonly<{
  env: "development" | "test" | "production";
  port: number;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  databaseUrl: string;
  testDatabaseUrl?: string;
  databaseSsl: boolean;
  dbPoolMax: number;
  corsOrigins: string[];
  jwt: { privateKeyPem: string; publicKeyPem: string; previousPublicKeyPem?: string };
  accessTokenTtl: string;
  refreshTokenTtlDays: number;
  cookieSecure: boolean;
  seedPassword: string;
  seedForcePasswordChange: boolean;
  rateLimitPerMinute: number;
  loginRateLimitPerMinute: number;
  loginRateLimitPerEmpPerMinute: number;
  sseHeartbeatMs: number;
  sseRetryMs: number;
  /** What Fastify's own `trustProxy` option accepts: `true`/`false`, a CIDR/IP (list) string,
   *  or — for a hop count — a function, per the note on `parseTrustProxy` below. */
  trustProxy: boolean | string | ((address: string, hop: number) => boolean);
}>;

const pem = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

/**
 * "true"/"false" -> boolean; anything else that isn't a bare integer (a CIDR, an IP, a
 * comma-separated list of either) passed through as a string for `@fastify/proxy-addr` to
 * parse. A bare integer ("1", "2", …) is the interesting case: Fastify 5 treats a raw
 * `number` here as a no-op for security — see its `trustProxy` docs: "Hop-count-only trust is
 * disabled because it cannot validate the immediate peer and lets direct clients spoof
 * X-Forwarded-* values" — and its TS type doesn't even accept `number`. So a hop count is
 * reproduced with an equivalent trust function instead: trust exactly the nearest `hops`
 * entries in the forwarded chain and take the address beyond them as the client. This is only
 * as safe as Fastify's own docs say hop-count trust ever is — it assumes the origin cannot be
 * reached except through that many trusted hops (e.g. a ClusterIP Service reachable only via
 * the ALB/ingress, or the local Vite dev proxy on one machine); it does not itself validate
 * *which* addresses those hops are.
 */
function parseTrustProxy(v: string): Config["trustProxy"] {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_address: string, hop: number) => hop < hops;
  }
  return v;
}

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
    dbPoolMax: e.DB_POOL_MAX,
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
    loginRateLimitPerEmpPerMinute: e.LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE,
    sseHeartbeatMs: e.SSE_HEARTBEAT_MS,
    sseRetryMs: e.SSE_RETRY_MS,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
  });
}
