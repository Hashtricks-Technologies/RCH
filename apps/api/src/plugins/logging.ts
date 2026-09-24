import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";

/** Request id in, request id out; user id on every access line once auth has run; and on a
 *  refused request, what it was refused with (`refusal`, set by `plugins/errors.ts`) - so the
 *  line for a 401 on `/auth/login` says whether the id was unknown, the password wrong or the
 *  account deactivated, which the response deliberately does not. */
export default fp(async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });
  app.addHook("onResponse", async (req, reply) => {
    req.log.info({
      route: req.routeOptions?.url ?? scrubUrl(req.url), method: req.method, status: reply.statusCode,
      ms: Math.round(reply.elapsedTime), user: (req as { user?: { sub?: string } }).user?.sub,
      ...(req.refusal ? { refusal: req.refusal } : {}),
    }, "request");
  });
}, { name: "logging" });

/**
 * A URL as it may be logged. A QR order's status page proves itself with the order's secret in
 * the query (`GET /public/orders/:id?k=…`, a GET has no body), and a log line is read by far more
 * people than may follow somebody's order - so on that path the `k` value is replaced before any
 * line is written. Every other URL is logged as it came.
 */
export const scrubUrl = (url: string): string =>
  url.includes("/public/orders") ? url.replace(/([?&]k=)[^&#]*/g, "$1[redacted]") : url;

/** Anything with a `write(line)` - pino's own destination shape. A test hands one in to read
 *  the lines back; production leaves it out and pino writes to stdout. */
export type LogStream = { write: (line: string) => void };

export const loggerOptions = (level: string, stream?: LogStream) => ({
  level,
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"], censor: "[redacted]" },
  serializers: { req: (r: { method: string; url: string }) => ({ method: r.method, url: scrubUrl(r.url) }) },
  ...(stream ? { stream } : {}),
});
export const genReqId = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const h = req.headers["x-request-id"];
  const v = Array.isArray(h) ? h[0] : h;
  return v && /^[\w.-]{1,128}$/.test(v) ? v : randomUUID();
};
