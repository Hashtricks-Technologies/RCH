import fp from "fastify-plugin";
import type { FastifyReply } from "fastify";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { UnauthenticatedError } from "../../lib/errors.js";
import { createAuthService } from "./service.js";
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from "./cookies.js";

export default fp(async (app) => {
  const svc = createAuthService(app.db, app.config);
  const meta = (req: { headers: Record<string, unknown>; ip: string }) => ({ userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200), ip: req.ip });
  const respond = async (reply: FastifyReply, s: Awaited<ReturnType<typeof svc.login>>) => {
    setRefreshCookie(reply, app.config, s.refreshToken, s.expiresAt);
    return { accessToken: await app.signAccess(s.claims), user: s.user, mustChangePassword: s.mustChangePassword };
  };
  mount(app, routes.login, async (req, reply) => respond(reply, await svc.login(req.body.emp, req.body.password, meta(req))),
    { config: { rateLimit: { max: app.config.loginRateLimitPerMinute, timeWindow: "1 minute" } } });
  mount(app, routes.refresh, async (req, reply) => {
    try {
      return await respond(reply, await svc.refresh(req.cookies[REFRESH_COOKIE], meta(req)));
    } catch (e) {
      // A dead refresh cookie (expired, revoked, or reused) is worth clearing client-side too,
      // so the browser stops presenting it on every subsequent request.
      if (e instanceof UnauthenticatedError) clearRefreshCookie(reply, app.config);
      throw e;
    }
  });
  mount(app, routes.logout, async (req, reply) => { await svc.logout(req.cookies[REFRESH_COOKIE]); clearRefreshCookie(reply, app.config); return { ok: true as const }; });
  // The reply carries a whole new session: the change revoked every token the caller held.
  mount(app, routes.changePassword, async (req, reply) => respond(reply, await svc.changePassword(req.user.sub, req.body.current, req.body.next, meta(req))));
}, { name: "module:auth", dependencies: ["auth", "rbac", "db"] });
