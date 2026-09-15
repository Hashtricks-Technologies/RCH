import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createVerifier } from "fast-jwt";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "../lib/errors.js";

/** The API's access-token claims. This service only verifies them and never signs one. */
export type AccessClaims = { sub: string; role: string; loc: string; mcp?: boolean; admin?: boolean };
type Gate = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module "fastify" {
  interface FastifyRequest { user: AccessClaims | null }
  interface FastifyInstance { authenticate: Gate; requireAdmin: Gate }
}

/**
 * Verify-only auth: the API's tokens, checked against its public key and, during a rotation, the
 * previous one. The same algorithm and issuer checks as `apps/api/src/plugins/auth.ts`, with
 * fast-jwt directly for both keys, for the reason that file gives.
 */
export default fp(async (app) => {
  const keys = [app.config.jwtPublicKeyPem, app.config.jwtPreviousPublicKeyPem].filter((k): k is string => Boolean(k));
  const verifiers = keys.map((key) => createVerifier({ key, algorithms: ["EdDSA"], allowedIss: "rch-api" }));

  app.decorateRequest("user", null);

  app.decorate("authenticate", async (req: FastifyRequest) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (token) {
      for (const verify of verifiers) {
        try {
          req.user = verify(token) as AccessClaims;
          return;
        } catch { /* the next key, then the refusal below */ }
      }
    }
    throw new UnauthenticatedError("Sign in to continue.");
  });

  /** The answer `rbac.ts` gives: an account without the flag learns nothing about the route, and a
   *  flagged token that must still change its password reaches no data. */
  app.decorate("requireAdmin", async (req: FastifyRequest) => {
    if (!req.user?.admin) throw new NotFoundError(`There is nothing at ${req.method} ${req.url}.`);
    if (req.user.mcp) throw new ForbiddenError("Change your password before you carry on.");
  });
}, { name: "auth", dependencies: ["errors"] });
