import { useSyncExternalStore } from "react";
import { API_PREFIX, EVENTS_PATH, EventNoticeSchema, type Changed } from "@rch/contract";
import { refreshOnce } from "./client";
import { getAccessToken, sessionLost } from "./session";
import { refetch } from "./refetch";
import { useApp } from "../store";

/**
 * The server's change feed, read with `fetch` rather than `EventSource`.
 *
 * `EventSource` cannot send an `Authorization` header, so it would force the access token into
 * the query string — where it lands in nginx's access log, the ALB's, and the browser's own
 * history. Reading `res.body` costs about seventy lines of parser and reuses `client.ts`'s
 * token and its refresh-once path, so the stream authenticates exactly as every other call.
 */
export type StreamState = "off" | "live" | "reconnecting";
/** Spec §6: the client refetches the affected slice, debounced 250 ms. */
export const EVENT_DEBOUNCE_MS = 250;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
const URL_ = `${BASE}${API_PREFIX}${EVENTS_PATH}`;

let state: StreamState = "off";
const watchers = new Set<() => void>();
const setState = (s: StreamState) => { if (s !== state) { state = s; for (const w of watchers) w(); } };

let controller: AbortController | null = null;
let attempt = 0;
let lastEventId: string | null = null;
let retryHintMs: number | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let pending = new Set<Changed>();
let wantsSnapshot = false;
let flush: ReturnType<typeof setTimeout> | null = null;

/** One refetch for a burst of notices, however many arrived. A resync supersedes the lot:
 *  there is no point reading three slices when the whole picture is being taken again. */
function schedule(): void {
  if (flush) return;
  flush = setTimeout(() => {
    flush = null;
    const slices = [...pending];
    const all = wantsSnapshot;
    pending = new Set();
    wantsSnapshot = false;
    if (all) void useApp.getState().loadSnapshot();
    else if (slices.length) void refetch(slices);
  }, EVENT_DEBOUNCE_MS);
}

/** One `\n\n`-separated frame: `id:`, `event:` and one or more `data:` lines. A line starting
 *  with `:` is a comment — the heartbeat — and a frame we cannot read is dropped, not fatal. */
function onFrame(text: string): void {
  let event = "message";
  const data: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith(":") || line === "") continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "id") lastEventId = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "retry") { const n = Number(value); if (Number.isFinite(n)) retryHintMs = n; }
  }
  if (event === "resync") { wantsSnapshot = true; schedule(); return; }
  if (event !== "changed" || data.length === 0) return;
  let parsed: unknown;
  try { parsed = JSON.parse(data.join("\n")); } catch { return; }
  const notice = EventNoticeSchema.safeParse(parsed);
  if (!notice.success) return;
  pending.add(notice.data.collection);
  schedule();
}

/** The headers a connection opens with — the token as a header, and the last id seen so a
 *  reconnect is answered with a resync rather than a replay. */
function open(ac: AbortController, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (lastEventId) headers["last-event-id"] = lastEventId;
  return fetch(URL_, { headers, credentials: "include", signal: ac.signal });
}

async function run(ac: AbortController): Promise<void> {
  let res = await open(ac, getAccessToken());
  if (res.status === 401) {
    // The same one-refresh-then-retry the typed client does; a second 401 is a dead session.
    if (!(await refreshOnce())) { sessionLost(); stop(); return; }
    res = await open(ac, getAccessToken());
    if (res.status === 401) { sessionLost(); stop(); return; }
  }
  if (!res.ok || !res.body) throw new Error(`events stream refused (${res.status})`);

  attempt = 0;
  setState("live");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut = buf.indexOf("\n\n");
    while (cut !== -1) { onFrame(buf.slice(0, cut)); buf = buf.slice(cut + 2); cut = buf.indexOf("\n\n"); }
  }
}

function connect(): void {
  // The controller is captured rather than read back from the module: `stop()` clears the
  // module's, and a `finally` that could not tell "aborted" from "cleared" would reconnect
  // behind a sign-out.
  const ac = new AbortController();
  controller = ac;
  void run(ac)
    .catch(() => { /* a drop is expected; the reconnect below is the answer */ })
    .finally(() => {
      if (ac.signal.aborted || controller !== ac) return;   // stopped on purpose, or superseded
      controller = null;
      setState("reconnecting");
      // The server's own `retry:` hint wins the first time; after that, back off.
      const wait = retryHintMs ?? BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
      retryHintMs = null;
      timer = setTimeout(connect, wait);
    });
}

function stop(): void {
  controller?.abort();
  controller = null;
  if (timer) { clearTimeout(timer); timer = null; }
  if (flush) { clearTimeout(flush); flush = null; }
  pending = new Set();
  wantsSnapshot = false;
  attempt = 0;
  lastEventId = null;
  retryHintMs = null;
  setState("off");
}

/**
 * Follow the session: a stream opens when one is ready and closes when it ends. Watching `auth`
 * rather than hooking `login()` also covers `restore()` and `changePassword()`, both of which
 * reach "ready" without passing through it.
 */
export function startEventStream(): () => void {
  const react = (auth: string) => {
    if (auth === "ready" && !controller && !timer) connect();
    else if (auth === "signed-out") stop();
  };
  react(useApp.getState().auth);
  const off = useApp.subscribe((s, prev) => { if (s.auth !== prev.auth) react(s.auth); });
  return () => { off(); stop(); };
}

/** For the shell's status pill. */
export function useStreamState(): StreamState {
  return useSyncExternalStore(
    (cb) => { watchers.add(cb); return () => { watchers.delete(cb); }; },
    () => state,
    () => "off" as const,
  );
}
