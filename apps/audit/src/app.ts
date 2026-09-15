import Fastify, { LogController, type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { AuditConfig } from "./config.js";
import logging, { genReqId, loggerOptions, type LogStream } from "./plugins/logging.js";
import errors from "./plugins/errors.js";
import metrics from "./plugins/metrics.js";
import health from "./plugins/health.js";
import security from "./plugins/security.js";

declare module "fastify" { interface FastifyInstance { config: AuditConfig } }

export type AuditApp = FastifyInstance;
/** `logStream` is where the log goes when it is not stdout - a test reading its own lines back.
 *  `drainer` says whether `plugins/drainer.ts` (Task 11) starts its LISTEN client and poll timer;
 *  a test that drives a pass by hand passes `false`. Task 10 adds the database handles. */
export type AppDeps = { logStream?: LogStream; drainer?: boolean };

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
  app.decorate("config", config);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(logging);
  await app.register(errors);
  await app.register(metrics);
  await app.register(health);
  await app.register(security);
  return app;
}
