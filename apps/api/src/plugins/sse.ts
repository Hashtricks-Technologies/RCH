import fp from "fastify-plugin";
import { Client } from "pg";
import { API_PREFIX, EVENTS_PATH } from "@rch/contract";
import type { Config } from "../config.js";
import { pgSsl } from "../db/client.js";
import { EVENTS_CHANNEL_PREFIX, type ChangeNotice } from "../lib/events.js";

declare module "fastify" {
  interface FastifyInstance { sse: { publish(n: ChangeNotice): void; resync(): void; clients(): number } }
}

type Stream = { write(frame: string): void; end(): void };

/** A LISTEN channel is an identifier; the schema name it carries is one already, but quote it
 *  anyway so a schema with an odd name cannot become syntax. */
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const frame = (id: number, event: string, data: string) => `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;
const BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000];

export default fp<{ config: Config; searchPath?: string }>(async (app, { config, searchPath }) => {
  const streams = new Set<Stream>();
  let seq = 0;
  const nextId = () => ++seq;

  const broadcast = (text: string) => { for (const s of streams) s.write(text); };
  const publish = (n: ChangeNotice) => {
    for (const collection of n.collections) broadcast(frame(nextId(), "changed", JSON.stringify({ collection, at: n.at })));
  };
  /** Every open stream may have missed something: tell them to take the whole thing again. */
  const resync = () => broadcast(frame(nextId(), "resync", JSON.stringify({ at: new Date().toISOString() })));
  app.decorate("sse", { publish, resync, clients: () => streams.size });

  // ---- the one connection that hears Postgres ---------------------------------
  let client: Client | null = null;
  let stopped = false;
  let attempt = 0;
  let everConnected = false;
  let retryTimer: NodeJS.Timeout | null = null;

  async function connect(): Promise<void> {
    if (stopped) return;
    const c = new Client({
      connectionString: config.databaseUrl,
      ssl: pgSsl(config.databaseSsl),
      options: searchPath ? `-c search_path=${searchPath}` : undefined,
      application_name: "rch-api-events",
    });
    // pg surfaces a dropped connection as an 'error' on the client; without a handler it is an
    // unhandled 'error' event and takes the process down.
    c.on("error", (err) => { app.log.warn({ err }, "events listener errored"); scheduleReconnect(c); });
    c.on("end", () => scheduleReconnect(c));
    try {
      await c.connect();
      const { rows } = await c.query<{ s: string }>("select current_schema() as s");
      await c.query(`listen ${quoteIdent(EVENTS_CHANNEL_PREFIX + rows[0].s)}`);
      c.on("notification", (m) => {
        if (!m.payload) return;
        try { publish(JSON.parse(m.payload) as ChangeNotice); }
        catch (err) { app.log.warn({ err, payload: m.payload }, "unreadable change notice"); }
      });
      client = c;
      attempt = 0;
      app.metrics.sseListenerUp.set(1);
      // A reconnect means notices were missed while it was down. The streams stayed open, so
      // nothing else would tell them; a resync is the catch-up.
      if (everConnected) resync();
      everConnected = true;
      app.log.info("events listener connected");
    } catch (err) {
      app.log.warn({ err }, "events listener could not connect");
      scheduleReconnect(c);
    }
  }

  function scheduleReconnect(dead: Client): void {
    if (stopped || retryTimer) return;
    if (client === dead) client = null;
    app.metrics.sseListenerUp.set(0);
    void dead.end().catch(() => {});
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
    app.metrics.sseClients.set(streams.size);
    // The hijack takes this response out of `onResponse`, so plugins/logging.ts will never
    // write its access line and plugins/metrics.ts will never time it — right for a request
    // that lasts an hour, but the operator should still see a stream open and close.
    req.log.info({ route: EVENTS_PATH, method: req.method, user: req.user.sub }, "stream open");
    const drop = () => {
      if (!streams.delete(stream)) return;
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
    app.metrics.sseClients.set(0);
    app.metrics.sseListenerUp.set(0);
    await client?.end().catch(() => {});
    client = null;
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
