import fp from "fastify-plugin";
import { Client } from "pg";
import { Counter, Gauge } from "prom-client";
import { pgSsl, withoutSslParams } from "../db/client.js";
import { drainOnce, outboxStats, type DrainTarget } from "../lib/drain.js";

/** The API notifies here after every outbox insert, with its outbox schema's name as the payload. */
export const AUDIT_OUTBOX_CHANNEL = "rch_audit_outbox";
/** `/readyz` answers 503 once the last successful pass is older than this (spec §3.3). */
export const READY_STALE_MS = 30_000;
/** How long `app.ready()` waits for the first pass before letting the server listen anyway. */
const FIRST_PASS_WAIT_MS = 5000;
/** The API's SSE listener backoff (apps/api/src/plugins/sse.ts). */
const BACKOFF_MS = [250, 500, 1000, 2000, 5000, 10_000];
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

export type Drainer = {
  readonly lastPassAt: Date | null;
  readonly lastPassOk: boolean;
  /** Ask for a pass. One already running absorbs the request and passes once more when done. */
  kick(): void;
  /** Kick, then resolve once no pass is running. Works with the drainer disabled. */
  drainNow(): Promise<void>;
  passes(): number;
  listening(): boolean;
};

declare module "fastify" {
  interface FastifyInstance { drainer: Drainer }
}

type PassOutcome = "full" | "short" | "failed";

/**
 * Moves the API's outbox into the log.
 *
 * - **Wakes on:** a notification on `rch_audit_outbox` naming this outbox (or naming none), a
 *   `DRAIN_POLL_MS` tick, a reconnect (notifications were missed while it was down), or a full batch.
 * - **Passes never overlap** within a process: a request made during a pass becomes one more pass
 *   after it. Across replicas, `skip locked` in `drainOnce` keeps them apart.
 * - **`enabled: false`** (tests that call `drainOnce` themselves) opens no LISTEN connection and sets
 *   no timer; `drainNow()` still runs a pass, so readiness and metrics stay testable.
 */
export default fp<{ enabled: boolean }>(async (app, { enabled }) => {
  const { config } = app;
  const target: DrainTarget = {
    auditSchema: config.auditSchema, outboxSchema: config.outboxSchema, eventsSchema: config.eventsSchema, batch: config.drainBatch,
  };

  const registers = [app.metrics.registry];
  const depth = new Gauge({ name: "audit_outbox_depth", help: "Rows waiting in the audit outbox, sampled after each pass", registers });
  const lag = new Gauge({ name: "audit_drain_lag_seconds", help: "Age of the oldest row waiting in the audit outbox, sampled after each pass", registers });
  const stored = new Counter({ name: "audit_events_stored_total", help: "Audit events moved from the outbox into the log", registers });
  const deadLetters = new Counter({ name: "audit_dead_letters_total", help: "Outbox rows set aside in dead_letters", registers });
  const listenerUp = new Gauge({ name: "audit_listener_up", help: "1 while the LISTEN connection on rch_audit_outbox is live", registers });
  listenerUp.set(0);

  // ---- passes ------------------------------------------------------------------
  let lastPassAt: Date | null = null;
  let lastPassOk = false;
  /** Readiness reads this, not `lastPassAt`: one failed pass between good ones is a blip the next
   *  tick retries, not a reason to pull the pod out of rotation. */
  let lastOkAt: Date | null = null;
  let passCount = 0;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  async function pass(): Promise<PassOutcome> {
    try {
      const r = await drainOnce(app.db, target);
      // Logged after the pass committed, so a line never names a row that was rolled back into the outbox.
      for (const d of r.issues) app.log.error({ outboxId: d.outboxId, issue: d.issue }, "audit event set aside in dead_letters");
      stored.inc(r.moved);
      deadLetters.inc(r.dead);
      const s = await outboxStats(app.db, target.outboxSchema);
      depth.set(s.depth);
      lag.set(s.lagSeconds);
      const now = new Date();
      lastPassAt = now;
      lastOkAt = now;
      lastPassOk = true;
      return r.moved + r.dead >= target.batch ? "full" : "short";
    } catch (err) {
      app.log.error({ err }, "audit drain pass failed");
      lastPassAt = new Date();
      lastPassOk = false;
      return "failed";
    } finally {
      passCount++;
    }
  }

  function kick(): void {
    if (stopped) return;
    if (running) { again = true; return; }
    running = (async () => {
      do {
        again = false;
        const outcome = await pass();
        // A failed pass is not retried in a loop: the next tick or notification tries again,
        // rather than hammering a database that just refused.
        if (outcome === "failed") break;
        if (outcome === "full") again = true;
      } while (again && !stopped);
    })().finally(() => { running = null; });
  }

  async function drainNow(): Promise<void> {
    kick();
    while (running) await running;
  }

  app.decorate("drainer", {
    get lastPassAt() { return lastPassAt; },
    get lastPassOk() { return lastPassOk; },
    kick,
    drainNow,
    passes: () => passCount,
    listening: () => client !== null,
  });

  app.readiness.addCheck("drainer", async () => {
    if (!lastOkAt) throw new Error("no drain pass has succeeded yet");
    const age = Date.now() - lastOkAt.getTime();
    if (age > READY_STALE_MS) throw new Error(`the last successful drain pass was ${Math.floor(age / 1000)} s ago`);
  });

  // ---- the one connection that hears the API -------------------------------------
  // The API's SSE listener discipline (apps/api/src/plugins/sse.ts), which explains every guard:
  // one live connection, a set that makes a second visible and closeable, `connecting` so a stale
  // event cannot start a connect beside one in flight, and a retire for a replaced connection.
  const connections = new Set<Client>();
  let client: Client | null = null;
  let connecting = false;
  let attempt = 0;
  let everConnected = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;

  const retire = (c: Client) => { connections.delete(c); void c.end().catch(() => {}); };

  async function connect(): Promise<void> {
    if (stopped || connecting) return;
    connecting = true;
    let opened: Client | null = null;
    let failed = false;
    try {
      const c = new Client({
        connectionString: withoutSslParams(config.databaseUrl),
        ssl: pgSsl(config.databaseSsl),
        // The schema rides along so `pg_stat_activity` tells replicas and test files apart.
        application_name: `rch-audit-drainer ${config.auditSchema}`,
      });
      opened = c;
      connections.add(c);
      c.on("error", (err) => { app.log.warn({ err }, "audit outbox listener errored"); scheduleReconnect(c); });
      c.on("end", () => { connections.delete(c); scheduleReconnect(c); });
      c.on("notification", (m) => {
        if (m.channel !== AUDIT_OUTBOX_CHANNEL) return;
        // The channel is database-wide; the payload names the outbox that was written (D14). Another
        // deployment's outbox sharing this database is not ours to drain. Empty means "anyone's".
        if (!m.payload || m.payload === config.outboxSchema) kick();
      });
      await c.connect();
      await c.query(`listen ${quoteIdent(AUDIT_OUTBOX_CHANNEL)}`);
      if (client && client !== c) retire(client);
      client = c;
      opened = null;
      attempt = 0;
      listenerUp.set(1);
      // A reconnect means notifications were missed while it was down: a pass is the catch-up.
      if (everConnected) kick();
      everConnected = true;
      app.log.info("audit outbox listener connected");
    } catch (err) {
      app.log.warn({ err }, "audit outbox listener could not connect");
      failed = true;
    } finally {
      connecting = false;
    }
    if (failed) scheduleReconnect(opened);
  }

  function scheduleReconnect(dead: Client | null): void {
    if (stopped || connecting || retryTimer) return;
    if (client && dead && client !== dead) return;
    client = null;
    listenerUp.set(0);
    if (dead) retire(dead);
    const wait = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
    retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, wait);
    retryTimer.unref();
  }

  app.addHook("onReady", async () => {
    if (!enabled) return;
    await connect();
    poll = setInterval(kick, config.drainPollMs);
    poll.unref();
    // Whatever piled up while no drainer ran goes now. `ready()` waits for that first pass, so a pod
    // that answers /readyz straight after start has really drained once - bounded, so a large backlog
    // or a slow database never holds the server's listen back.
    await Promise.race([drainNow(), new Promise((r) => { setTimeout(r, FIRST_PASS_WAIT_MS).unref(); })]);
  });

  // ---- shutdown ------------------------------------------------------------------
  async function shutdown(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (poll) clearInterval(poll);
    if (retryTimer) clearTimeout(retryTimer);
    listenerUp.set(0);
    const ends = [...connections].map((c) => c.end().catch(() => {}));
    connections.clear();
    client = null;
    // The pass in flight is a transaction on the pool; let it commit or roll back before anything
    // closes the pool. Bounded, so SIGTERM never waits on a black-holed socket.
    await Promise.race([Promise.all([...ends, running]), new Promise((r) => { setTimeout(r, 5000).unref(); })]);
  }
  // `preClose` runs ahead of the server closing and of every `onClose` (see sse.ts); `onClose` is the
  // belt for an app that never finished booting, and it still runs before `AppDeps.cleanup`.
  app.addHook("preClose", shutdown);
  app.addHook("onClose", shutdown);
}, { name: "drainer", dependencies: ["db", "metrics", "health"] });
