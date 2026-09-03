import fp from "fastify-plugin";
import { Registry, collectDefaultMetrics, Histogram, Gauge } from "prom-client";

declare module "fastify" {
  interface FastifyInstance { metrics: { registry: Registry; sseClients: Gauge } }
}

export default fp(async (app) => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const duration = new Histogram({
    name: "http_request_duration_seconds", help: "Request duration by route and status",
    labelNames: ["method", "route", "status"], buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
  });
  const sseClients = new Gauge({ name: "sse_clients", help: "Open /events streams", registers: [registry] });
  app.decorate("metrics", { registry, sseClients });
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    if (route === "/metrics") return;
    duration.labels(req.method, route, String(reply.statusCode)).observe(reply.elapsedTime / 1000);
  });
  app.get("/metrics", { config: { rateLimit: false } }, async (_req, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}, { name: "metrics" });
