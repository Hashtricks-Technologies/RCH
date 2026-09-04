import fp from "fastify-plugin";
import { Client } from "pg";
import { z } from "zod";
import { API_PREFIX, CollectionSchema, EVENTS_PATH } from "@rch/contract";
import type { Config } from "../config.js";
import { pgSsl } from "../db/client.js";
import { RateLimitedError } from "../lib/errors.js";
import { EVENTS_CHANNEL_PREFIX, type ChangeNotice } from "../lib/events.js";

declare module "fastify" {
  interface FastifyInstance {
    sse: {
      publish(n: ChangeNotice): void;
      resync(): void;
      clients(): number;
      /** LISTEN connections this pod is holding — one while it is healthy. A second would hear
       *  the same channel and deliver every notice twice, and a leaked one is invisible from
       *  outside the process, so the reconnect test counts them here. */
      listeners(): number;
    };
  }
}

type Stream = { write(frame: string): void; end(): void };

/** A LISTEN channel is an identifier; the schema name it carries is one already, but quote it
 *  anyway so a schema with an odd name cannot become syntax. */
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const frame = (id: number, event: string, data: string) => `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;
const BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000];

/**
 * How many streams one signed-in person may hold open at once.
 *
 * A stream is a socket and a slot in every broadcast for as long as it lives, and the global
 * rate limiter cannot see it — spec §6 turns the limiter off for this route, because a request
 * that lasts an hour is the wrong shape for a per-minute budget. Eight is far above a real
 * counter (a till, a spare tab, a phone) and far below what a reconnect loop with a bug in it
 * would open in a minute, which is the failure this bounds.
 */
const MAX_STREAMS_PER_USER = 8;

/** A NOTIFY channel is open to every session on the database, so what arrives on it is parsed
 *  rather than trusted: an unreadable payload is dropped instead of waking every browser with
 *  a collection name no client knows what to do with. */
const ChangeNoticeSchema = z.strictObject({ collections: z.array(CollectionSchema).min(1), at: z.string() });
/** `JSON.parse` that answers `undefined` instead of throwing, so a payload that is not JSON and
 *  a payload that is the wrong shape are refused down one path, not two. */
const tryJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

export default fp<{ config: Config; searchPath?: string }>(async (app, { config, searchPath }) => {
  const streams = new Set<Stream>();
  /** Open streams per signed-in person, so the cap above is enforced on the one thing that
   *  identifies a browser across reconnects. A person with none is absent, not zero. */
  const perUser = new Map<string, number>();
  let seq = 0;
  const nextId = () => ++seq;

  const broadcast = (text: string) => { for (const s of streams) s.write(text); };
  const publish = (n: ChangeNotice) => {
    for (const collection of n.collections) broadcast(frame(nextId(), "changed", JSON.stringify({ collection, at: n.at })));
  };
  /** Every open stream may have missed something: tell them to take the whole thing again. */
  const resync = () => broadcast(frame(nextId(), "resync", JSON.stringify({ at: new Date().toISOString() })));

  // ---- the one connection that hears Postgres ---------------------------------
  /** Every connection opened and not yet ended. There is only ever meant to be one; the set is
   *  what makes a second one — which would double every notice — visible and closeable. */
  const connections = new Set<Client>();
  let client: Client | null = null;
  let stopped = false;
  /** True from the moment a connect starts to the moment it settles. A stale event arriving in
   *  that window would otherwise find `client` null and `retryTimer` cleared, and start a
   *  second connect beside the one already in flight. */
  let connecting = false;
  let attempt = 0;
  let everConnected = false;
  let retryTimer: NodeJS.Timeout | null = null;

  app.decorate("sse", { publish, resync, clients: () => streams.size, listeners: () => connections.size });

  const retire = (c: Client) => { connections.delete(c); void c.end().catch(() => {}); };

  async function connect(): Promise<void> {
    if (stopped || connecting) return;
    connecting = true;
    /** The connection this attempt opened, until it takes. Whatever is still here at the end
     *  never became the listener, and `scheduleReconnect` below is the one path that gives it
     *  back — ending it here as well would call `end()` twice on the same client. */
    let opened: Client | null = null;
    let failed = false;
    try {
      const c = new Client({
        connectionString: config.databaseUrl,
        ssl: pgSsl(config.databaseSsl),
        options: searchPath ? `-c search_path=${searchPath}` : undefined,
        // The schema rides along so `pg_stat_activity` says which listener is which when
        // several share one database — every test file does, and so would two releases
        // passing each other mid-rollout.
        application_name: searchPath ? `rch-api-events ${searchPath.split(",")[0]}` : "rch-api-events",
      });
      opened = c;
      connections.add(c);
      // pg surfaces a dropped connection as an 'error' on the client; without a handler it is
      // an unhandled 'error' event and takes the process down.
      c.on("error", (err) => { app.log.warn({ err }, "events listener errored"); scheduleReconnect(c); });
      c.on("end", () => { connections.delete(c); scheduleReconnect(c); });
      await c.connect();
      const { rows } = await c.query<{ s: string }>("select current_schema() as s");
      await c.query(`listen ${quoteIdent(EVENTS_CHANNEL_PREFIX + rows[0].s)}`);
      c.on("notification", (m) => {
        if (!m.payload) return;
        const parsed = ChangeNoticeSchema.safeParse(tryJson(m.payload));
        if (!parsed.success) { app.log.warn({ payload: m.payload }, "unreadable change notice"); return; }
        publish(parsed.data);
      });
      // A connection replaced without ever having emitted 'end' would go on hearing the
      // channel: every notice would arrive twice and its backend would never be given back.
      if (client && client !== c) retire(client);
      client = c;
      opened = null;
      attempt = 0;
      app.metrics.sseListenerUp.set(1);
      // A reconnect means notices were missed while it was down. The streams stayed open, so
      // nothing else would tell them; a resync is the catch-up.
      if (everConnected) resync();
      everConnected = true;
      app.log.info("events listener connected");
    } catch (err) {
      app.log.warn({ err }, "events listener could not connect");
      failed = true;
    } finally {
      // In `finally`, and before the retry is scheduled: a throw that left this set would stop
      // every future reconnect, and the pod would stay deaf until someone restarted it.
      connecting = false;
    }
    if (failed) scheduleReconnect(opened);
  }

  function scheduleReconnect(dead: Client | null): void {
    // A connect already in flight *is* the reconnect, and a timer already set is the same
    // answer waiting to run: either way, starting another opens a connection nobody owns.
    if (stopped || connecting || retryTimer) return;
    // An event from a connection that has already been replaced says nothing about the live
    // one. Acting on it would pull the healthy listener down and start a second beside it,
    // and every notice would then reach the browsers twice.
    if (client && dead && client !== dead) return;
    client = null;
    app.metrics.sseListenerUp.set(0);
    if (dead) retire(dead);
    const wait = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, wait);
    retryTimer.unref();
  }

  app.metrics.sseListenerUp.set(0);
  // A DB-less app (`buildTestApp({ withDb: false })`) has no database to listen to; opening a
  // raw Client against `config.databaseUrl` there would make a test that wants no Postgres
  // depend on one being reachable to stay quiet.
  if (app.hasDecorator("db")) await connect();

  // ---- the heartbeat -----------------------------------------------------------
  // A comment line keeps proxies and load balancers from reaping an idle stream, and gives the
  // browser a write to notice when the pod goes away without a FIN.
  const beat = setInterval(() => broadcast(": ping\n\n"), config.sseHeartbeatMs);
  beat.unref();

  // ---- the route ---------------------------------------------------------------
  app.get(API_PREFIX + EVENTS_PATH, {
    // The global limiter runs on preHandler and would count every reconnect; a stream that is
    // one request for an hour is the wrong shape for a per-minute budget.
    config: { rateLimit: false },
    preHandler: [app.authenticate],
  }, async (req, reply) => {
    const who = req.user.sub;
    // Before the hijack, and only before it: once the response is hijacked there is no reply
    // left to serialise an envelope onto, and the browser would be handed a dead stream instead
    // of a sentence it can show.
    if ((perUser.get(who) ?? 0) >= MAX_STREAMS_PER_USER) {
      throw new RateLimitedError(`You already have ${MAX_STREAMS_PER_USER} screens listening for updates. Close one and try again.`);
    }
    reply.hijack();
    const res = reply.raw;
    // Fastify's connectionTimeout is Node's per-socket inactivity timer; at 10 s it would kill
    // the stream between 25 s heartbeats. requestTimeout is a *receive* timer and a GET's
    // request has already ended, so it never applies here.
    req.raw.socket.setTimeout(0);
    req.raw.socket.setNoDelay(true);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      // writeHead goes straight to the socket, past everything plugins/logging.ts's onRequest
      // hook put on the reply — so the header a client correlates a report by is set again here.
      "x-request-id": String(req.id),
    });
    const stream: Stream = {
      write: (text) => { try { res.write(text); } catch { /* the socket went; the close handler below cleans up */ } },
      end: () => { try { res.end(); } catch { /* already gone */ } },
    };
    streams.add(stream);
    perUser.set(who, (perUser.get(who) ?? 0) + 1);
    app.metrics.sseClients.set(streams.size);
    // The hijack takes this response out of `onResponse`, so plugins/logging.ts will never
    // write its access line and plugins/metrics.ts will never time it — right for a request
    // that lasts an hour, but the operator should still see a stream open and close.
    req.log.info({ route: EVENTS_PATH, method: req.method, user: req.user.sub }, "stream open");
    const drop = () => {
      // The guard is `streams.delete`, not the log line: both 'close' and 'error' fire on a
      // socket that goes away, and a second decrement would give this person back a slot they
      // never used.
      if (!streams.delete(stream)) return;
      const left = (perUser.get(who) ?? 1) - 1;
      if (left > 0) perUser.set(who, left); else perUser.delete(who);
      app.metrics.sseClients.set(streams.size);
      req.log.info({ route: EVENTS_PATH, method: req.method, user: req.user.sub }, "stream closed");
    };
    res.on("close", drop);
    res.on("error", drop);

    stream.write(`retry: ${config.sseRetryMs}\n\n`);
    // No replay log: a client that missed notices refetches everything rather than trusting a
    // buffer that does not survive a pod being rescheduled.
    if (req.headers["last-event-id"]) stream.write(frame(nextId(), "resync", JSON.stringify({ at: new Date().toISOString() })));
  });

  // ---- shutdown (spec §12) ------------------------------------------------------
  /** Let every open stream go, with a hint about when to come back, and stop listening.
   *  Fastify's forceCloseConnections: "idle" will not touch a socket a stream is holding —
   *  `server.close()` only reaps a connection once its response has ended, so ending them is
   *  what lets SIGTERM finish inside the grace period. */
  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearInterval(beat);
    if (retryTimer) clearTimeout(retryTimer);
    for (const s of streams) { s.write(`retry: ${config.sseRetryMs}\n\n`); s.end(); }
    streams.clear();
    perUser.clear();
    app.metrics.sseClients.set(0);
    app.metrics.sseListenerUp.set(0);
    // Every connection, not just the current one: a pod that goes down mid-reconnect must not
    // leave a backend behind holding a LISTEN. Bounded, because a graceful end on a socket
    // that is black-holed rather than closed never completes, and SIGTERM must not wait on it
    // past the grace period — the process is going away, and the backend goes with it.
    const ends = [...connections].map((c) => c.end().catch(() => {}));
    connections.clear();
    client = null;
    await Promise.race([Promise.all(ends), new Promise((r) => { setTimeout(r, 2000).unref(); })]);
  }
  // `preClose`, not `onClose`: Fastify registers its own close handler last (at preReady) and
  // avvio runs them in reverse, so its handler — the one that calls `server.close()` — runs
  // *before* every plugin's `onClose`. A stream ended from `onClose` would be ended after the
  // server had already sat down to wait for it, and close() would hang on its own socket.
  // `preClose` hooks run inside that handler, ahead of the server closing.
  app.addHook("preClose", shutdown);
  // An app that never finished booting never registered the handler above, so `preClose` never
  // runs; this is the belt to its braces, and `stopped` makes the second call a no-op.
  app.addHook("onClose", shutdown);
}, { name: "sse", dependencies: ["auth", "metrics"] });
