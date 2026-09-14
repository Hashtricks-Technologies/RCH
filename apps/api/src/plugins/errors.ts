import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { AppError, NotFoundError, ValidationError } from "../lib/errors.js";

/** What a 4xx was refused with, for the request's own log line. `cause` is the internal reason
 *  an `AppError` carried; the sentence is the one the caller read. Set here, read once in
 *  `plugins/logging.ts`'s `onResponse`, and never serialised into a response. */
export type Refusal = { code: string; message: string; cause?: string };
declare module "fastify" { interface FastifyRequest { refusal?: Refusal } }

export default fp(async (app) => {
  app.setNotFoundHandler((req, reply) => {
    const e = new NotFoundError(`There is nothing at ${req.method} ${req.url}.`);
    req.refusal = { code: e.code, message: e.message };
    reply.code(404).send(e.toEnvelope());
  });
  app.setErrorHandler((err, req, reply) => {
    // A 4xx is the caller's to read and the operator's to look up later: the envelope carries
    // the sentence, and the same sentence - plus the code and any internal cause - goes onto
    // the request's log line. A 5xx is logged in full below instead.
    const refuse = (status: number, refusal: Refusal, envelope?: unknown) => {
      req.refusal = refusal;
      return reply.code(status).send(envelope ?? { error: { code: refusal.code, message: refusal.message } });
    };
    if (hasZodFastifySchemaValidationErrors(err)) {
      const details = err.validation.map((v) => ({ path: v.instancePath || "/", message: v.message }));
      const e = new ValidationError("The request did not match what this endpoint expects.", details);
      return refuse(400, { code: e.code, message: e.message }, e.toEnvelope());
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err, issues: err.cause.issues }, "response failed its schema");
      return reply.code(500).send({ error: { code: "internal", message: `Something went wrong on our side. Reference ${req.id}.` } });
    }
    if (err instanceof AppError) {
      if (err.status < 500) return refuse(err.status, { code: err.code, message: err.message, ...(err.cause === undefined ? {} : { cause: err.cause }) }, err.toEnvelope());
      return reply.code(err.status).send(err.toEnvelope());   // a NotReadyError is expected, not unhandled
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return refuse(429, { code: "rate_limited", message: "Too many requests - wait a moment and try again." });
    if (status === 503) return reply.code(503).send({ error: { code: "not_ready", message: (err as Error).message } });
    if (status === 401) return refuse(401, { code: "unauthenticated", message: "Sign in to continue.", cause: (err as Error).message });
    if (status && status >= 400 && status < 500) return refuse(status, { code: "validation", message: (err as Error).message });
    req.log.error({ err }, "unhandled");
    return reply.code(500).send({ error: { code: "internal", message: `Something went wrong on our side. Reference ${req.id}.` } });
  });
}, { name: "errors" });
