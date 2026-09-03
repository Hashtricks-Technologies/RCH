import type { FastifyReply } from "fastify";
import type { Config } from "../../config.js";

export const REFRESH_COOKIE = "rch_refresh";
const PATH = "/api/v1/auth";

/** The cookie dies when the row does: a rotation late in a family's life is capped at the
 *  family's 30 days, and a browser holding the cookie past that would only learn of it on a 401. */
export const setRefreshCookie = (reply: FastifyReply, config: Config, value: string, expiresAt: Date) =>
  reply.setCookie(REFRESH_COOKIE, value, { httpOnly: true, secure: config.cookieSecure, sameSite: "strict", path: PATH, expires: expiresAt });

export const clearRefreshCookie = (reply: FastifyReply, config: Config) =>
  reply.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: "strict", path: PATH });
