import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import logging, { genReqId, loggerOptions } from "./plugins/logging.js";
import security from "./plugins/security.js";
import errors from "./plugins/errors.js";
import metrics from "./plugins/metrics.js";
import health from "./plugins/health.js";

export type App = FastifyInstance;

export async function buildApp(config: Config): Promise<App> {
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
  // Task 5 adds the database plugin here; Task 8 adds the route mount.
  return app;
}
