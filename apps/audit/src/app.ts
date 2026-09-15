import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { AuditConfig } from "./config.js";
import type { Db } from "./db/client.js";
import logging, { genReqId, loggerOptions, type LogStream } from "./plugins/logging.js";
import errors from "./plugins/errors.js";
import metrics from "./plugins/metrics.js";
import health from "./plugins/health.js";
import security from "./plugins/security.js";
import db from "./plugins/db.js";

declare module "fastify" { interface FastifyInstance { config: AuditConfig } }

export type AuditApp = FastifyInstance;
/**
 * - `db` + `pool`: a handle the caller owns (the test harness); otherwise the db plugin opens one on
 *   `searchPath`, which defaults to `config.auditSchema`.
 * - `logStream`: where the log goes when it is not stdout - a test reading its own lines back.
 * - `drainer`: whether `plugins/drainer.ts` starts its LISTEN client and poll timer; a test that
 *   drives a pass by hand passes `false`.
 * - `cleanup`: run once the app has closed, after every plugin's own `onClose` - the test harness
 *   drops its schemas there.
 */
export type AppDeps = { db?: Db; pool?: Pool; searchPath?: string; logStream?: LogStream; drainer?: boolean; cleanup?: () => Promise<void> };

export async function buildApp(config: AuditConfig, deps: AppDeps = {}): Promise<AuditApp> {
  const app = Fastify({
    logger: loggerOptions(config.logLevel, deps.logStream),
    genReqId,
    trustProxy: config.trustProxy,
    // Every route is a GET; nothing this service accepts has a body worth more than a header.
    bodyLimit: 64 * 1024,
    forceCloseConnections: "idle",
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  }).withTypeProvider<ZodTypeProvider>();
  // The first onClose hook added is the last to run (avvio runs them newest first), so a caller's
  // cleanup comes after every plugin has let go of the pool.
  const cleanup = deps.cleanup;
  if (cleanup) app.addHook("onClose", async () => { await cleanup(); });
  app.decorate("config", config);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(logging);
  await app.register(errors);
  await app.register(metrics);
  await app.register(health);
  await app.register(security);
  await app.register(db, { url: config.databaseUrl, ssl: config.databaseSsl, max: config.dbPoolMax, searchPath: deps.searchPath ?? config.auditSchema, auditSchema: config.auditSchema, db: deps.db, pool: deps.pool });
  return app;
}
