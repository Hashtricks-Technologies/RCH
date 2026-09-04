import type { z } from "zod";
import { API_PREFIX, routes, type AnyRoute } from "@rch/contract";
import { getAccessToken, sessionLost, setAccessToken } from "./session";

/**
 * The server's error envelope, thrown. `message` is written for the person at
 * the screen, so a caller can hand it straight to `notify()`.
 */
export class ApiError extends Error {
  // Parameter properties are not erasable syntax, so the fields are declared.
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
type Input = { params?: Record<string, string | number>; query?: Record<string, string | number | undefined>; body?: unknown };
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

function url(route: AnyRoute, input: Input): string {
  let p = route.path.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(String(input.params?.[k] ?? "")));
  const q = Object.entries(input.query ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  if (q) p += `?${q}`;
  return `${BASE}${API_PREFIX}${p}`;
}

/** A write's Idempotency-Key, or undefined for anything that does not need one. */
const idempotencyKeyFor = (route: AnyRoute): string | undefined =>
  (route.write ?? route.method !== "GET") && route.access !== "public" ? crypto.randomUUID() : undefined;

async function raw(route: AnyRoute, input: Input, token: string | null, idempotencyKey?: string): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  return fetch(url(route, input), { method: route.method, headers, credentials: "include", body: input.body === undefined ? undefined : JSON.stringify(input.body) });
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Not our envelope at all: a gateway's HTML error page, a proxy timeout. Raising the
      // raw SyntaxError would put "Unexpected token '<'" in front of the operator.
      throw new ApiError("internal", `The server returned an unexpected response (${res.status}).`, res.status);
    }
  }
  if (res.ok) return body;
  const e = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  throw new ApiError(e?.code ?? "internal", e?.message ?? `Request failed (${res.status}).`, res.status, e?.details);
}

let refreshing: Promise<boolean> | null = null;
/** Exported for the event stream, which authenticates the same way `call()` does but cannot
 *  go through it — its response never ends. Single-flight: two callers share one request. */
export async function refreshOnce(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await raw(routes.refresh, {}, null);
      if (!r.ok) return false;
      const b = (await r.json()) as { accessToken: string };
      setAccessToken(b.accessToken);
      return true;
    } catch { return false; } finally { refreshing = null; }
  })();
  return refreshing;
}

/** Call a manifest route. Adding an endpoint is one manifest entry — never a new function here. */
export async function call<R extends AnyRoute>(route: R, input: Input = {}): Promise<z.infer<R["response"]>> {
  // Minted once per call, not once per fetch: the retry after a refresh is the *same* write,
  // and a second key would let the server run it twice — exactly what the header is for.
  const key = idempotencyKeyFor(route);
  let res = await raw(route, input, getAccessToken(), key);
  if (res.status === 401 && !route.path.startsWith("/auth/")) {
    if (await refreshOnce()) res = await raw(route, input, getAccessToken(), key);
    else { sessionLost(); }
  }
  return parse(res) as Promise<z.infer<R["response"]>>;
}
