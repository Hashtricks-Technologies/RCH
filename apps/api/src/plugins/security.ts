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
    // Default is `onRequest`, which runs long before `authenticate` (a route preHandler) —
    // so `req.user` was always undefined and every authenticated request keyed on the IP,
    // giving a whole ward behind one NAT a single shared budget. `preHandler` is appended to
    // each route's existing preHandler array (see the plugin's onRoute hook), i.e. after the
    // ones mount() attached, so by the time the limiter runs an authenticated request has a
    // `req.user` to key on and a public one still falls back to the IP.
    //
    // The cost of moving it: a request `authenticate` or `roleGate` rejects never reaches the
    // limiter, so bad tokens no longer eat an IP budget. The brute-forceable surface — login
    // and refresh — is public, has no preHandler in front of the limiter, and keeps its
    // per-IP budget (login carries a tighter route-level one on top).
    hook: "preHandler",
    keyGenerator: (req) => (req as { user?: { sub?: string } }).user?.sub ?? req.ip,
    // @fastify/rate-limit throws whatever this returns — hand it a real Error (with
    // .status/.statusCode) so plugins/errors.ts's `err instanceof AppError` branch maps it
    // to 429, not a plain object it can't recognize.
    errorResponseBuilder: () => new RateLimitedError(),
  });
  await app.register(underPressure, {
    maxEventLoopDelay: 1000,
    maxHeapUsedBytes: 0,
    maxRssBytes: 0,
    message: "The service is overloaded — try again shortly.",
    retryAfter: 5,
    // No customError: under-pressure's default error carries our `message` and a real
    // `statusCode: 503`; a bare `class extends Error {}` here drops both.
  });
}, { name: "security" });
