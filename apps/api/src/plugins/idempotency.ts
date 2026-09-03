// Stub — Task 10 replaces the body with the Idempotency-Key store/replay.
import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyInstance { idempotency: (req: FastifyRequest, reply: FastifyReply) => Promise<void> }
}

export default fp(async (app) => {
  app.decorate("idempotency", async (_req: FastifyRequest, _reply: FastifyReply) => {});
}, { name: "idempotency", dependencies: ["auth", "db"] });
