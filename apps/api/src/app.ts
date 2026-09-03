import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import logging, { genReqId, loggerOptions } from "./plugins/logging.js";
import security from "./plugins/security.js";
import errors from "./plugins/errors.js";
import metrics from "./plugins/metrics.js";
import health from "./plugins/health.js";
import db from "./plugins/db.js";

export type App = FastifyInstance;
export type AppDeps = { db?: Db; searchPath?: string; migrationsSchema?: string };

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<App> {
  const app = Fastify({
    logger: loggerOptions(config.logLevel),
    genReqId,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    forceCloseConnections: "idle",
    disableRequestLogging: true, // the logging plugin writes one structured line per request instead
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(logging);
  await app.register(errors);
  await app.register(metrics);
  await app.register(health);
  await app.register(security, { config });
  await app.register(db, { url: config.databaseUrl, ssl: config.databaseSsl, searchPath: deps.searchPath, migrationsSchema: deps.migrationsSchema, db: deps.db });
  // Task 8 adds the route mount.
  return app;
}
