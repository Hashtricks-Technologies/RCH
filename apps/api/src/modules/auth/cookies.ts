import type { FastifyReply } from "fastify";
import type { Config } from "../../config.js";

export const REFRESH_COOKIE = "rch_refresh";
const PATH = "/api/v1/auth";

export const setRefreshCookie = (reply: FastifyReply, config: Config, value: string) =>
  reply.setCookie(REFRESH_COOKIE, value, { httpOnly: true, secure: config.cookieSecure, sameSite: "strict", path: PATH, maxAge: config.refreshTokenTtlDays * 86400 });

export const clearRefreshCookie = (reply: FastifyReply, config: Config) =>
  reply.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: "strict", path: PATH });
