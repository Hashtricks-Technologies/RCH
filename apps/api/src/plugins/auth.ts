import fp from "fastify-plugin";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import { createVerifier } from "fast-jwt";
import type { LocKey, Role } from "@rch/contract";
import type { Config } from "../config.js";
import { UnauthenticatedError } from "../lib/errors.js";

export type AccessClaims = { sub: string; role: Role; loc: LocKey; mcp: boolean };
declare module "@fastify/jwt" { interface FastifyJWT { payload: AccessClaims; user: AccessClaims } }
declare module "fastify" {
  interface FastifyInstance {
    authenticate: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
    signAccess: (u: { id: string; role: Role; loc: LocKey; mcp: boolean }) => Promise<string>;
  }
}

export default fp<{ config: Config }>(async (app, { config }) => {
  await app.register(cookie);
  await app.register(jwt, {
    secret: { private: config.jwt.privateKeyPem, public: config.jwt.publicKeyPem },
    sign: { algorithm: "EdDSA", expiresIn: config.accessTokenTtl, iss: "rch-api" },
    verify: { algorithms: ["EdDSA"], allowedIss: "rch-api" },
  });
  // A rotated-out key is still accepted for verification for a day (spec §8.2).
  //
  // @fastify/jwt v10's `verify(token, { key })` override does not merge with the plugin's
  // configured `algorithms`/`allowedIss` - passing `key` replaces the whole verify-options
  // object (see mergeOptionsWithKey in @fastify/jwt/index.js), so a caller-supplied override
  // would silently accept any algorithm and skip the issuer check. Verifying the previous key
  // with fast-jwt directly (the library @fastify/jwt itself uses) keeps those checks explicit.
  const previous = config.jwt.previousPublicKeyPem;
  const verifyPrevious = previous
    ? createVerifier({ key: previous, algorithms: ["EdDSA"], allowedIss: "rch-api" })
    : undefined;
  app.decorate("authenticate", async (req) => {
    try {
      await req.jwtVerify();
    } catch (e) {
      if (verifyPrevious) {
        try {
          req.user = verifyPrevious(extractBearer(req.headers.authorization)) as AccessClaims;
          return;
        } catch { /* fall through to the unauthenticated error below */ }
      }
      const code = (e as { code?: string }).code;
      throw new UnauthenticatedError(code === "FST_JWT_AUTHORIZATION_TOKEN_EXPIRED" ? "Your session has expired - sign in again." : "Sign in to continue.");
    }
  });
  app.decorate("signAccess", async (u) => app.jwt.sign({ sub: u.id, role: u.role, loc: u.loc, mcp: u.mcp }));
}, { name: "auth", dependencies: ["errors"] });

function extractBearer(h: string | undefined): string {
  const m = /^Bearer (.+)$/.exec(h ?? "");
  if (!m) throw new UnauthenticatedError();
  return m[1];
}
