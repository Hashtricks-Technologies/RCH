import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import logging, { genReqId, loggerOptions } from "./plugins/logging.js";
import security from "./plugins/security.js";
import errors from "./plugins/errors.js";
import metrics from "./plugins/metrics.js";
import health from "./plugins/health.js";
import db from "./plugins/db.js";
import auth from "./plugins/auth.js";
import rbac from "./plugins/rbac.js";
import sse from "./plugins/sse.js";
import idempotency from "./plugins/idempotency.js";
import { registerModules } from "./modules/index.js";

declare module "fastify" { interface FastifyInstance { config: Config } }

export type App = FastifyInstance;
/** A caller that brings its own database brings the pool behind it too, so /metrics can still report its depth. */
export type AppDeps = { db?: Db; pool?: Pool; searchPath?: string; migrationsSchema?: string };

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<App> {
  const app = Fastify({
    logger: loggerOptions(config.logLevel),
    genReqId,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    forceCloseConnections: "idle",
    disableRequestLogging: true, // the logging plugin writes one structured line per request instead
    // Requests must finish inside the idempotency stale window (CLAIM_STALE_MS,
    // plugins/idempotency.ts): otherwise a client's retry could take over a claim while the
    // original, merely-slow request is still running, and both would execute the write.
    // `requestTimeout` bounds how long Fastify lets a request run once headers are in;
    // `connectionTimeout` bounds how long it waits for those headers to arrive at all. Both
    // are well inside CLAIM_STALE_MS (120s), so a takeover only ever finds a truly dead claim.
    requestTimeout: 30_000,
    connectionTimeout: 10_000,
  }).withTypeProvider<ZodTypeProvider>();
  app.decorate("config", config);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(logging);
  await app.register(errors);
  await app.register(metrics);
  await app.register(health);
  await app.register(security, { config });
  await app.register(db, { url: config.databaseUrl, ssl: config.databaseSsl, searchPath: deps.searchPath, migrationsSchema: deps.migrationsSchema, db: deps.db, pool: deps.pool });
  await app.register(auth, { config });
  await app.register(rbac);
  await app.register(sse, { config, searchPath: deps.searchPath });
  await app.register(idempotency);
  await registerModules(app);
  return app;
}
