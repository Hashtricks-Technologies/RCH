import fp from "fastify-plugin";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";
import { AppError, NotFoundError, ValidationError } from "../lib/errors.js";

export default fp(async (app) => {
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(new NotFoundError(`There is nothing at ${req.method} ${req.url}.`).toEnvelope());
  });
  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const details = err.validation.map((v) => ({ path: v.instancePath || "/", message: v.message }));
      return reply.code(400).send(new ValidationError("The request did not match what this endpoint expects.", details).toEnvelope());
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err, issues: err.cause.issues }, "response failed its schema");
      return reply.code(500).send({ error: { code: "internal", message: `Something went wrong on our side. Reference ${req.id}.` } });
    }
    if (err instanceof AppError) {
      return reply.code(err.status).send(err.toEnvelope());
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: { code: "rate_limited", message: "Too many requests — wait a moment and try again." } });
    if (status === 503) return reply.code(503).send({ error: { code: "not_ready", message: (err as Error).message } });
    if (status === 401) return reply.code(401).send({ error: { code: "unauthenticated", message: "Sign in to continue." } });
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: { code: "validation", message: (err as Error).message } });
    req.log.error({ err }, "unhandled");
    return reply.code(500).send({ error: { code: "internal", message: `Something went wrong on our side. Reference ${req.id}.` } });
  });
}, { name: "errors" });
