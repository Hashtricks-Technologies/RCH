import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { routes } from "@rch/contract";
import { mount } from "../../routes.js";
import { recordAuthEvent, type AuthEvent } from "../../lib/audit.js";
import { AppError, RateLimitedError, UnauthenticatedError } from "../../lib/errors.js";
import { createAuthService, LoginRefused } from "./service.js";
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie } from "./cookies.js";

/** Per client IP, per pod, like the login limit - but kept apart from it and far looser. The
 *  sign-in screen reads the picker once each time it is opened, and a hospital's counters can
 *  all sit behind one address, so a shift change is many honest reads at once; what this stops
 *  is a script walking the page in a loop. The global limit still applies on top. */
const DIRECTORY_RATE_LIMIT_PER_MINUTE = 120;

/** What a sign-in event says when the attempt went through. A refusal carries the sentence the
 *  caller was actually shown instead. */
const SIGNED_IN = "Signed in";
const SIGNED_OUT = "Signed out";
const PASSWORD_CHANGED = "Password changed - every other session was signed out";
/** The two lockouts' causes, for the trail - neither refusal has one of its own. */
const PER_EMP_LIMIT = "too many attempts for this employee id";
const PER_IP_LIMIT = "per-IP sign-in limit";

/**
 * What the audit trail keeps of a typed employee id: the id when it is shaped like one (`RC-` and
 * digits, the only shape `nextEmpNo` hands out), and nothing otherwise. The log line has never kept
 * an unknown id at all (service.ts), because what was typed into that box may have been the
 * password. The trail is kept forever, so it keeps only the shape that cannot be one: "somebody
 * tried RC-0000" still reads, and a password typed into the wrong box never lands in it.
 */
const EMP_SHAPE = /^RC-\d+$/i;
const typedEmpOf = (emp: string | undefined): string => (emp !== undefined && EMP_SHAPE.test(emp) ? emp : "");

/** The refusal sentence out of an error envelope on its way to the socket. */
const sentenceOf = (payload: unknown): string => {
  if (typeof payload !== "string") return "";
  try { return (JSON.parse(payload) as { error?: { message?: string } }).error?.message ?? ""; } catch { return ""; }
};

export default fp(async (app) => {
  const svc = createAuthService(app.db, app.config);
  const meta = (req: { headers: Record<string, unknown>; ip: string }) => ({ userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200), ip: req.ip });
  /** The `AuthResponse` every one of these routes answers with: the access token minted from the
   *  session's own claim, the caller, and every counter they may stand at. */
  const authResponse = async (s: Awaited<ReturnType<typeof svc.switchLocation>>) =>
    ({ accessToken: await app.signAccess(s.claims), user: s.user, mustChangePassword: s.mustChangePassword, postings: s.postings });
  const respond = async (reply: FastifyReply, s: Awaited<ReturnType<typeof svc.login>>) => {
    setRefreshCookie(reply, app.config, s.refreshToken, s.expiresAt);
    return authResponse(s);
  };
  /**
   * Sign-in events go to the outbox on the pool: there is no write transaction for them to ride
   * in (spec §2.6). One that cannot be stored is logged with the request id and never turns a
   * sign-in, or its refusal, into a 500 - the stance a refusal's event takes (plugins/audit.ts).
   * Every call names `request` itself, so no password, typed or new, is ever handed over.
   */
  const audit = (req: FastifyRequest, e: AuthEvent): Promise<void> =>
    recordAuthEvent(app.db, req, e).catch((err: unknown) => { req.log.error({ err, action: e.action, outcome: e.outcome }, "audit event not stored"); });
  /** Requests the login route's own per-IP limiter turned away. The limiter throws from a
   *  preHandler, so the handler below never runs for them: `onExceeded` marks the request, and the
   *  `onSend` hook at the bottom records it before the 429 leaves. */
  const ipLimited = new WeakSet<FastifyRequest>();

  mount(app, routes.login, async (req, reply) => {
    const typedEmp = typedEmpOf(req.body.emp);
    const request = { body: { emp: typedEmp } };
    try {
      const session = await svc.login(req.body.emp, req.body.password, meta(req), req.body.loc);
      const body = await respond(reply, session);
      await audit(req, { action: "login", outcome: "done", status: 200, message: SIGNED_IN, actorId: session.user.id, request });
      return body;
    } catch (e) {
      if (e instanceof AppError) {
        await audit(req, {
          action: "login", outcome: "refused", status: e.status, message: e.message,
          cause: e instanceof RateLimitedError ? PER_EMP_LIMIT : e.cause ?? null,
          actorId: e instanceof LoginRefused ? e.userId : null, typedEmp, request,
        });
      }
      throw e;
    }
  }, { config: { rateLimit: {
    max: app.config.loginRateLimitPerMinute, timeWindow: "1 minute",
    onExceeded: (req: FastifyRequest) => { ipLimited.add(req); },
  } } });
  // Public, and deliberately so: it is read before anybody has signed in. It says who can sign
  // in (a number and a name) and nothing a password could be guessed from.
  mount(app, routes.signInDirectory, async () => svc.directory(),
    { config: { rateLimit: { max: DIRECTORY_RATE_LIMIT_PER_MINUTE, timeWindow: "1 minute" } } });
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
  // Moving this session to another of the caller's postings. `write: false` in the manifest, so
  // it carries no idempotency key and leaves no audit event: nothing in the hospital's records
  // changes - only which counter this one token speaks for.
  mount(app, routes.switchLocation, async (req) =>
    authResponse(await svc.switchLocation(req.user, req.body.loc, req.cookies[REFRESH_COOKIE])));
  mount(app, routes.logout, async (req, reply) => {
    const userId = await svc.logout(req.cookies[REFRESH_COOKIE]);
    clearRefreshCookie(reply, app.config);
    if (userId) await audit(req, { action: "logout", outcome: "done", status: 200, message: SIGNED_OUT, actorId: userId, request: {} });
    return { ok: true as const };
  });
  // The reply carries a whole new session: the change revoked every token the caller held.
  mount(app, routes.changePassword, async (req, reply) => {
    try {
      const body = await respond(reply, await svc.changePassword(req.user.sub, req.body.current, req.body.next, meta(req)));
      await audit(req, { action: "changePassword", outcome: "done", status: 200, message: PASSWORD_CHANGED, actorId: req.user.sub, request: {} });
      return body;
    } catch (e) {
      if (e instanceof AppError) {
        await audit(req, { action: "changePassword", outcome: "refused", status: e.status, message: e.message, cause: e.cause ?? null, actorId: req.user.sub, request: {} });
      }
      throw e;
    }
  });

  app.addHook("onSend", async (req, reply, payload) => {
    if (!ipLimited.has(req)) return payload;
    ipLimited.delete(req);
    const typedEmp = typedEmpOf((req.body as { emp?: string } | undefined)?.emp);
    await audit(req, {
      action: "login", outcome: "refused", status: reply.statusCode, message: sentenceOf(payload),
      cause: PER_IP_LIMIT, actorId: null, typedEmp, request: { body: { emp: typedEmp } },
    });
    return payload;
  });
}, { name: "module:auth", dependencies: ["auth", "rbac", "db"] });
