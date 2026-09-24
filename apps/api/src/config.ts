import { z } from "zod";
import { QR_MAX_RUPEES } from "@rch/domain";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
/** Compose hands every variable it names to the container, set or not - `${X:-}` is an empty
 *  string, not an absent one - so for the optional QR settings an empty value means "unset": the
 *  default for a number (never `0`, which `z.coerce` would make of it), and no key for a secret. */
const blank = (v: unknown) => (v === "" ? undefined : v);
const optionalSecret = z.preprocess(blank, z.string().min(1).optional());
const intOr = (min: number, max: number, dflt: number) => z.preprocess(blank, int(min, max).default(dflt));

const EnvShape = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(0, 65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.url().startsWith("postgres"),
  /** Who the migrate step and the operator CLIs connect as (`cliDatabaseUrl`). Unset, they use
   *  DATABASE_URL - local development and the tests, where one user does everything. Set to a
   *  different user, `db:migrate` also makes DATABASE_URL's user the API's least-privilege role
   *  (`lib/roles.ts`). The server itself never reads it. */
  MIGRATE_DATABASE_URL: z.url().startsWith("postgres").optional(),
  TEST_DATABASE_URL: z.url().startsWith("postgres").optional(),
  /** Left unset, production verifies the RDS chain and a laptop does not - see `databaseSsl`
   *  below. Set it either way to overrule that. */
  DATABASE_SSL: bool.optional(),
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
  /** No default, on purpose. A published default is the same password on every host that ever
   *  ran the seed, and a seeded account's must-change token still reaches `changePassword`, so
   *  a takeover through one is permanent. Whoever seeds a host chooses the password. */
  SEED_PASSWORD: z.string().min(12),
  SEED_FORCE_PASSWORD_CHANGE: bool.default(true),
  RATE_LIMIT_PER_MINUTE: int(10, 100_000).default(300),
  LOGIN_RATE_LIMIT_PER_MINUTE: int(1, 1000).default(10),
  LOGIN_RATE_LIMIT_PER_EMP_PER_MINUTE: int(1, 1000).default(5),
  SSE_HEARTBEAT_MS: int(10, 300_000).default(25_000),
  SSE_RETRY_MS: int(100, 60_000).default(1000),
  /** "true"/"false", a hop count ("1", "2", …, translated to an equivalent trust function -
   *  see `parseTrustProxy`), or a raw CIDR/IP (list) handed straight to `proxy-addr`. */
  TRUST_PROXY: z.string().min(1).default("1"),
  // ---- item photos ----
  /** Where photo bytes live. `disk` is a laptop's and the test suite's; production refuses it,
   *  because a second replica would not see the first one's folder. */
  IMAGE_STORE: z.enum(["disk", "s3"]).default("disk"),
  IMAGE_DIR: z.string().min(1).default(".data/images"),
  IMAGE_BUCKET: z.string().min(3).optional(),
  AWS_REGION: z.string().min(1).optional(),
  // ---- QR ordering (deploy/RUNBOOK.md §19). The three keys are all or nothing: with none, the
  // gateway is off (`app.payments` is null) and placing a QR order answers 503.
  RAZORPAY_KEY_ID: optionalSecret,
  RAZORPAY_KEY_SECRET: optionalSecret,
  RAZORPAY_WEBHOOK_SECRET: optionalSecret,
  /** The most one QR order may come to, in rupees. */
  QR_ORDER_MAX_RUPEES: intOr(1, 1_000_000, QR_MAX_RUPEES),
  /** Minutes an unpaid QR order waits for its payment before the worker expires it. */
  QR_ORDER_TTL_MIN: intOr(1, 24 * 60, 30),
  /** Milliseconds between QR worker passes (expiry and refunds). `0` switches the worker off. */
  QR_WORKER_INTERVAL_MS: intOr(0, 3_600_000, 30_000),
});

const Env = EnvShape.superRefine((e, ctx) => {
  if (e.IMAGE_STORE === "s3") {
    if (!e.IMAGE_BUCKET) ctx.addIssue({ code: "custom", path: ["IMAGE_BUCKET"], message: "required when IMAGE_STORE=s3" });
    if (!e.AWS_REGION) ctx.addIssue({ code: "custom", path: ["AWS_REGION"], message: "required when IMAGE_STORE=s3" });
  } else if (e.NODE_ENV === "production") {
    ctx.addIssue({ code: "custom", path: ["IMAGE_STORE"], message: "production keeps photos in S3 - set IMAGE_STORE=s3, IMAGE_BUCKET and AWS_REGION" });
  }
  // Some of the three keys and not the others is a half-finished setup, not a choice: refused at
  // start-up rather than left to answer 503 to every customer while looking configured.
  const keys = [e.RAZORPAY_KEY_ID, e.RAZORPAY_KEY_SECRET, e.RAZORPAY_WEBHOOK_SECRET];
  if (keys.some(Boolean) && !keys.every(Boolean)) {
    for (const [k, v] of [["RAZORPAY_KEY_ID", e.RAZORPAY_KEY_ID], ["RAZORPAY_KEY_SECRET", e.RAZORPAY_KEY_SECRET], ["RAZORPAY_WEBHOOK_SECRET", e.RAZORPAY_WEBHOOK_SECRET]] as const) {
      if (!v) ctx.addIssue({ code: "custom", path: [k], message: "set all three Razorpay keys together, or none of them" });
    }
  }
});

export class ConfigError extends Error {}

export type Config = Readonly<{
  env: "development" | "test" | "production";
  port: number;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  databaseUrl: string;
  migrateDatabaseUrl: string | undefined;
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
   *  or - for a hop count - a function, per the note on `parseTrustProxy` below. */
  trustProxy: boolean | string | ((address: string, hop: number) => boolean);
  // ---- item photos ----
  images: { store: "disk"; dir: string } | { store: "s3"; bucket: string; region: string };
  // ---- QR ordering ----
  /** The payment gateway's keys, or null when none are set (the gateway is off). */
  razorpay: { keyId: string; keySecret: string; webhookSecret: string } | null;
  qr: { maxRupees: number; ttlMin: number; workerIntervalMs: number };
}>;

const pem = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

/**
 * "true"/"false" -> boolean; anything else that isn't a bare integer (a CIDR, an IP, a
 * comma-separated list of either) passed through as a string for `@fastify/proxy-addr` to
 * parse. A bare integer ("1", "2", …) is the interesting case: Fastify 5 treats a raw
 * `number` here as a no-op for security - see its `trustProxy` docs: "Hop-count-only trust is
 * disabled because it cannot validate the immediate peer and lets direct clients spoof
 * X-Forwarded-* values" - and its TS type doesn't even accept `number`. So a hop count is
 * reproduced with an equivalent trust function instead: trust exactly the nearest `hops`
 * entries in the forwarded chain and take the address beyond them as the client. This is only
 * as safe as Fastify's own docs say hop-count trust ever is - it assumes the origin cannot be
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
    migrateDatabaseUrl: e.MIGRATE_DATABASE_URL,
    testDatabaseUrl: e.TEST_DATABASE_URL,
    // Unset means "whatever this environment ought to be": production talks to RDS and verifies
    // the bundled CA, a laptop talks to a container on 5439 and does not. An explicit
    // DATABASE_SSL still wins in both directions - a staging pod pointed at a local proxy can
    // turn it off, and a developer pointed at a real instance can turn it on.
    databaseSsl: e.DATABASE_SSL ?? e.NODE_ENV === "production",
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
    // ---- item photos ----
    images: e.IMAGE_STORE === "s3"
      ? ({ store: "s3", bucket: e.IMAGE_BUCKET ?? "", region: e.AWS_REGION ?? "" } as const)
      : ({ store: "disk", dir: e.IMAGE_DIR } as const),
    // ---- QR ordering ----
    razorpay: e.RAZORPAY_KEY_ID && e.RAZORPAY_KEY_SECRET && e.RAZORPAY_WEBHOOK_SECRET
      ? { keyId: e.RAZORPAY_KEY_ID, keySecret: e.RAZORPAY_KEY_SECRET, webhookSecret: e.RAZORPAY_WEBHOOK_SECRET }
      : null,
    qr: { maxRupees: e.QR_ORDER_MAX_RUPEES, ttlMin: e.QR_ORDER_TTL_MIN, workerIntervalMs: e.QR_WORKER_INTERVAL_MS },
  });
}

/** The URL an operator CLI connects with: the migrate user where one is configured, the runtime
 *  URL otherwise. `buildApp` never uses it - the server always connects with `databaseUrl`, which in
 *  a deployment is the runtime role that cannot read or rewrite the audit outbox. */
export const cliDatabaseUrl = (c: Config): string => c.migrateDatabaseUrl ?? c.databaseUrl;
