import fp from "fastify-plugin";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import underPressure from "@fastify/under-pressure";
import sensible from "@fastify/sensible";
import type { Config } from "../config.js";
import { RateLimitedError } from "../lib/errors.js";

export default fp<{ config: Config }>(async (app, { config }) => {
  await app.register(sensible);
  await app.register(helmet, { contentSecurityPolicy: false }); // the API serves JSON; CSP belongs to the UI's nginx
  await app.register(cors, { origin: config.corsOrigins, credentials: true, exposedHeaders: ["x-request-id"] });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitPerMinute,
    timeWindow: "1 minute",
    keyGenerator: (req) => (req as { user?: { sub?: string } }).user?.sub ?? req.ip,
    errorResponseBuilder: () => new RateLimitedError().toEnvelope(),
  });
  await app.register(underPressure, {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 0,
    maxRssBytes: 0,
    message: "The service is overloaded — try again shortly.",
    retryAfter: 5,
    customError: class extends Error {},
  });
}, { name: "security" });
