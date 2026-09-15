import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const pem = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

/** The API's JWT_PUBLIC_KEY, verbatim: a PEM public key, base64-encoded so it survives an env
 *  file. Checked here so a mangled key stops the process at start rather than 401-ing every
 *  request after it. */
const publicKey = z.string().min(1).refine((v) => pem(v).includes("-----BEGIN PUBLIC KEY-----"), "must be a base64-encoded PEM public key");

/**
 * A schema name. It is spliced into SQL as a quoted identifier and, for EVENTS_SCHEMA, into a
 * NOTIFY channel, so it is held to lower-case letters, digits and underscores - nothing quoting
 * could be escaped out of - and never `pg_…`, which Postgres reserves. `max` is what is left of
 * Postgres's 63-byte identifier limit after the suffix this service adds: `_drizzle` (8) to
 * AUDIT_SCHEMA, the `rch_events_` prefix (11) to EVENTS_SCHEMA.
 */
const schemaName = (max: number) => z.string()
  .regex(/^[a-z_][a-z0-9_]*$/, "must be lower-case letters, digits and underscores, not starting with a digit")
  .max(max)
  .refine((v) => !v.startsWith("pg_"), "may not start with pg_, which Postgres reserves");

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(0, 65535).default(3100),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** The runtime connection, as `rch_audit` everywhere but a laptop and the test suite. */
  AUDIT_DATABASE_URL: z.url().startsWith("postgres"),
  /** The migrate CLI's connection (as `rch`). Unset, the CLI uses AUDIT_DATABASE_URL and skips
   *  role setup, because the runtime user is then the migrate user (src/lib/roles.ts). */
  MIGRATE_DATABASE_URL: z.url().startsWith("postgres").optional(),
  /** Left unset, production verifies the RDS chain and a laptop does not - as in the API. */
  DATABASE_SSL: bool.optional(),
  /** One drain pass and one read each take a single connection, and the LISTEN client is not a
   *  pool member, so five is room for two admins reading while a pass runs. */
  DB_POOL_MAX: int(1, 200).default(5),
  JWT_PUBLIC_KEY: publicKey,
  /** Empty is the same as unset: `.env.example` ships the line blank. */
  JWT_PREVIOUS_PUBLIC_KEY: z.union([z.literal(""), publicKey]).optional(),
  /** Same grammar as the API's TRUST_PROXY - see `parseTrustProxy`. */
  TRUST_PROXY: z.string().min(1).default("1"),
  AUDIT_SCHEMA: schemaName(55).default("audit"),
  EVENTS_SCHEMA: schemaName(52).default("public"),
  OUTBOX_SCHEMA: schemaName(63).default("public"),
  DRAIN_BATCH: int(1, 5000).default(500),
  DRAIN_POLL_MS: int(100, 25_000).default(5000),   // under the drainer's 30 s readiness window, or /readyz flaps on a quiet pod
}).superRefine((e, ctx) => {
  // The migrate CLI revokes PUBLIC's rights on AUDIT_SCHEMA and the service's role gets no
  // privilege on the API's tables: pointing it at `public`, or at the schema the API's own tables
  // live in, would do both to the API.
  if (e.AUDIT_SCHEMA === "public" || e.AUDIT_SCHEMA === e.OUTBOX_SCHEMA || e.AUDIT_SCHEMA === e.EVENTS_SCHEMA) {
    ctx.addIssue({ code: "custom", path: ["AUDIT_SCHEMA"], message: "must be a schema of its own, not public and not the outbox or events schema" });
  }
});

export class ConfigError extends Error {}

export type AuditConfig = Readonly<{
  env: "development" | "test" | "production";
  port: number;
  logLevel: z.infer<typeof Env>["LOG_LEVEL"];
  databaseUrl: string;
  migrateDatabaseUrl: string;
  databaseSsl: boolean;
  dbPoolMax: number;
  jwtPublicKeyPem: string;
  jwtPreviousPublicKeyPem?: string;
  /** What Fastify's own `trustProxy` accepts. A hop count becomes a function, because Fastify 5
   *  treats a bare number as a no-op (apps/api/src/config.ts explains the whole of it). */
  trustProxy: boolean | string | ((address: string, hop: number) => boolean);
  auditSchema: string;
  eventsSchema: string;
  outboxSchema: string;
  drainBatch: number;
  drainPollMs: number;
}>;

/** "true"/"false" -> boolean; a bare integer -> trust exactly that many nearest hops; anything
 *  else (a CIDR, an IP, a list) -> passed to `proxy-addr` as it is. Identical to the API's. */
function parseTrustProxy(v: string): AuditConfig["trustProxy"] {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_address: string, hop: number) => hop < hops;
  }
  return v;
}

/** The only reader of `process.env` in this package (the test harness aside). */
export function loadConfig(env: NodeJS.ProcessEnv): AuditConfig {
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
    databaseUrl: e.AUDIT_DATABASE_URL,
    migrateDatabaseUrl: e.MIGRATE_DATABASE_URL ?? e.AUDIT_DATABASE_URL,
    databaseSsl: e.DATABASE_SSL ?? e.NODE_ENV === "production",
    dbPoolMax: e.DB_POOL_MAX,
    jwtPublicKeyPem: pem(e.JWT_PUBLIC_KEY),
    jwtPreviousPublicKeyPem: e.JWT_PREVIOUS_PUBLIC_KEY ? pem(e.JWT_PREVIOUS_PUBLIC_KEY) : undefined,
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    auditSchema: e.AUDIT_SCHEMA,
    eventsSchema: e.EVENTS_SCHEMA,
    outboxSchema: e.OUTBOX_SCHEMA,
    drainBatch: e.DRAIN_BATCH,
    drainPollMs: e.DRAIN_POLL_MS,
  });
}
