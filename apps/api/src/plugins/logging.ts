import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";

/** Request id in, request id out; user id on every access line once auth has run. */
export default fp(async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  app.addHook("onResponse", async (req, reply) => {
    req.log.info({
      route: req.routeOptions?.url ?? req.url, method: req.method, status: reply.statusCode,
      ms: Math.round(reply.elapsedTime), user: (req as { user?: { sub?: string } }).user?.sub,
    }, "request");
  });
}, { name: "logging" });

export const loggerOptions = (level: string) => ({
  level,
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"], censor: "[redacted]" },
  serializers: { req: (r: { method: string; url: string }) => ({ method: r.method, url: r.url }) },
});
export const genReqId = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const h = req.headers["x-request-id"];
  const v = Array.isArray(h) ? h[0] : h;
  return v && /^[\w.-]{1,128}$/.test(v) ? v : randomUUID();
};
