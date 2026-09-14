import type { z } from "zod";
import { API_PREFIX, routes, type AnyRoute } from "@rch/contract";
import { getAccessToken, onSessionLost, sessionLost, setAccessToken } from "./session";

/**
 * The server's error envelope, thrown. `message` is written for the person at
 * the screen, so a caller can hand it straight to `notify()`.
 */
export class ApiError extends Error {
  // Parameter properties are not erasable syntax, so the fields are declared.
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  /** The `x-request-id` this request carried - the browser's own, echoed by the server, so the
   *  id in "Reference <id>" on screen is the id in the API's log line for the same request. */
  readonly requestId?: string;
  constructor(code: string, message: string, status: number, details?: unknown, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
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

type Stamps = { idempotencyKey?: string; requestId: string };

async function raw(route: AnyRoute, input: Input, token: string | null, stamps: Stamps): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json", "x-request-id": stamps.requestId };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (stamps.idempotencyKey) headers["idempotency-key"] = stamps.idempotencyKey;
  return fetch(url(route, input), { method: route.method, headers, credentials: "include", body: input.body === undefined ? undefined : JSON.stringify(input.body) });
}

async function parse(res: Response, sent: string): Promise<unknown> {
  // The server echoes the id it was given and names it in its own 500 sentence. Prefer what
  // came back, so a proxy that minted its own is the one the operator can be asked to quote.
  const requestId = res.headers.get("x-request-id") ?? sent;
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Not our envelope at all: a gateway's HTML error page, a proxy timeout. Raising the
      // raw SyntaxError would put "Unexpected token '<'" in front of the operator.
      throw new ApiError("internal", `The server returned an unexpected response (${res.status}).`, res.status, undefined, requestId);
    }
  }
  if (res.ok) return body;
  const e = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  throw new ApiError(e?.code ?? "internal", e?.message ?? `Request failed (${res.status}).`, res.status, e?.details, requestId);
}

/* ---------- one refresh, however many tabs ---------- */

/** The refresh cookie belongs to the browser, not to a tab. Two tabs that refresh at the same
 *  instant present the same rotated token twice, which the server reads as a stolen token and
 *  answers by revoking the whole family - signing both of them out mid-shift. The lock makes
 *  the second tab wait; the broadcast means it does not need to refresh at all when it wakes. */
const REFRESH_LOCK = "rch-refresh";
const SESSION_CHANNEL = "rch-session";
type Locks = { request: <T>(name: string, fn: () => Promise<T>) => Promise<T> };
const lockManager = (): Locks | undefined =>
  (globalThis.navigator as unknown as { locks?: Locks } | undefined)?.locks;

let channel: BroadcastChannel | null = null;
let channelCtor: unknown = null;
/** Open (once) the channel this tab both listens on and announces a new token over. */
function sessionChannel(): BroadcastChannel | null {
  const Ctor = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (!Ctor) return null;
  if (channel && channelCtor === Ctor) return channel;
  channel = new Ctor(SESSION_CHANNEL);
  channelCtor = Ctor;
  channel.onmessage = (e: MessageEvent) => {
    const t = (e.data as { accessToken?: unknown } | null)?.accessToken;
    // A broadcast **replaces** a token this tab already holds; it never hands one out. A tab on
    // the sign-in screen, or one whose family was revoked, holds nothing - and on a shared
    // terminal adopting here would let the next person at the keyboard walk into the session
    // of whoever is signed in in the tab beside it.
    if (typeof t === "string" && t && getAccessToken() !== null) setAccessToken(t);
  };
  return channel;
}

/** Sign-out and session-loss close it; the next `call()` opens a fresh one, by which time this
 *  tab is signing in again and has its own token to protect. */
export function closeSessionChannel(): void {
  channel?.close();
  channel = null;
  channelCtor = null;
}
// A refresh that failed is the end of the session - stop listening for other tabs' tokens
// before this tab can be handed one it has no business holding.
onSessionLost(closeSessionChannel);

/** Say so, without letting a closed or refused channel turn a successful refresh into a failure. */
function announce(accessToken: string): void {
  try { sessionChannel()?.postMessage({ accessToken }); } catch { /* the token is set either way */ }
}

let refreshing: Promise<boolean> | null = null;

async function refreshInLock(had: string | null): Promise<boolean> {
  // Whoever else was in here may have finished the job. A token that is no longer the one this
  // caller's 401 was raised against is a *newer* token, so the right answer is "retry", not
  // "refresh again" - the second refresh is exactly what revokes the family.
  const now = getAccessToken();
  if (had !== null && now !== null && now !== had) return true;
  try {
    const r = await raw(routes.refresh, {}, null, { requestId: crypto.randomUUID() });
    if (!r.ok) return false;
    const b = (await r.json()) as { accessToken: string };
    setAccessToken(b.accessToken);
    announce(b.accessToken);
    return true;
  } catch { return false; }
}

/** Exported for the event stream, which authenticates the same way `call()` does but cannot
 *  go through it - its response never ends. Single-flight within the tab, and serialised
 *  across them by `navigator.locks` where the browser has it. `had` is the token the caller's
 *  401 was raised against, so a tab that waited can tell "nothing happened" from "tab 2 did it". */
export async function refreshOnce(had: string | null = null): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const locks = lockManager();
      if (!locks) return await refreshInLock(had);
      // `request` itself rejects on a document that is not fully active, and throws where the
      // API is present but unusable. `refreshInLock` never rejects, so a rejection here means
      // it was never reached: fall back to the lock-less path rather than escaping `call()` as
      // something no caller is typed to catch.
      try { return await locks.request(REFRESH_LOCK, () => refreshInLock(had)); }
      catch { return await refreshInLock(had); }
    } finally { refreshing = null; }
  })();
  return refreshing;
}

/** Call a manifest route. Adding an endpoint is one manifest entry - never a new function here. */
export async function call<R extends AnyRoute>(route: R, input: Input = {}): Promise<z.infer<R["response"]>> {
  sessionChannel();      // this tab listens from its first call, whether or not it ever refreshes
  // Minted once per call, not once per fetch: the retry after a refresh is the *same* write,
  // and a second key would let the server run it twice - exactly what the header is for. The
  // request id travels with it for the same reason: one id names one attempt end to end.
  const stamps: Stamps = { idempotencyKey: idempotencyKeyFor(route), requestId: crypto.randomUUID() };
  const had = getAccessToken();
  let res = await raw(route, input, had, stamps);
  if (res.status === 401 && !route.path.startsWith("/auth/")) {
    if (await refreshOnce(had)) res = await raw(route, input, getAccessToken(), stamps);
    else { sessionLost(); }
  }
  return parse(res, stamps.requestId) as Promise<z.infer<R["response"]>>;
}
