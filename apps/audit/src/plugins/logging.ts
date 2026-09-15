import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";

/** Request id in, request id out, and one access line per request - carrying, on a refusal,
 *  what it was refused with (`refusal`, set by `plugins/errors.ts`). A slim copy of the API's. */
export default fp(async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  app.addHook("onResponse", async (req, reply) => {
    req.log.info({
      route: req.routeOptions?.url ?? req.url, method: req.method, status: reply.statusCode,
      ms: Math.round(reply.elapsedTime), user: (req as { user?: { sub?: string } }).user?.sub,
      ...(req.refusal ? { refusal: req.refusal } : {}),
    }, "request");
  });
}, { name: "logging" });

/** Anything with a `write(line)` - pino's own destination shape. A test hands one in to read
 *  the lines back; production leaves it out and pino writes to stdout. */
export type LogStream = { write: (line: string) => void };

export const loggerOptions = (level: string, stream?: LogStream) => ({
  level,
  redact: { paths: ["req.headers.authorization", "req.headers.cookie"], censor: "[redacted]" },
  serializers: { req: (r: { method: string; url: string }) => ({ method: r.method, url: r.url }) },
  ...(stream ? { stream } : {}),
});

/** The caller's `x-request-id` when it is a plain token (the API's, forwarded by the UI's proxy),
 *  otherwise a fresh UUID - a header is never trusted into the log unchecked. */
export const genReqId = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const h = req.headers["x-request-id"];
  const v = Array.isArray(h) ? h[0] : h;
  return v && /^[\w.-]{1,128}$/.test(v) ? v : randomUUID();
};
