import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { buildTestApp, putOutbox, sampleEvent } from "../test/app.js";
import { AUDIT_OUTBOX_CHANNEL, READY_STALE_MS } from "./drainer.js";

/** A pass that fails, or one that takes nothing, on demand; otherwise the real thing. Hoisted
 *  because a `vi.mock` factory is lifted above the imports. */
const drain = vi.hoisted(() => ({ mode: "real" as "real" | "fail" | "idle" }));
vi.mock("../lib/drain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/drain.js")>();
  return {
    ...actual,
    drainOnce: async (...args: Parameters<typeof actual.drainOnce>) => {
      if (drain.mode === "fail") throw new Error("Connection terminated unexpectedly");
      if (drain.mode === "idle") return { moved: 0, dead: 0, issues: [] };
      return actual.drainOnce(...args);
    },
  };
});

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
/** Drainer off: a pass happens only when a case asks for one. Batch 5, so a full batch is cheap. */
let app: TestApp;
/** Drainer on, polling once a minute: inside a case, only a notification can wake it. */
let live: TestApp;
let liveClosed = false;

beforeAll(async () => {
  app = await buildTestApp({ schema: "drainer", drainer: false, env: { DRAIN_BATCH: "5" } });
  await app.ready();
  live = await buildTestApp({ schema: "drainer_live", drainer: true, env: { DRAIN_POLL_MS: "25000" } });
  await live.ready();
});
afterAll(async () => {
  await app.close();
  if (!liveClosed) await live.close();
});
beforeEach(() => { drain.mode = "real"; });

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await check()) return true;
    await settle(25);
  }
  return check();
}
async function metric(a: TestApp, name: string): Promise<number> {
  const body = (await a.inject({ method: "GET", url: "/metrics" })).body;
  const m = new RegExp(`^${name} (\\S+)$`, "m").exec(body);
  if (!m) throw new Error(`${name} is not on /metrics`);
  return Number(m[1]);
}
const tagged = (tag: string, n: number) => Array.from({ length: n }, (_, i) => sampleEvent({ requestId: `${tag}-${i}` }));
async function storedCount(a: TestApp, tag: string): Promise<number> {
  const r = await a.db.execute(sql`
    select count(*)::int as n from ${sql.identifier(a.testDb.auditSchema)}.events where request_id like ${`${tag}-%`}`);
  return (r.rows[0] as { n: number }).n;
}
async function outboxDepth(a: TestApp): Promise<number> {
  const r = await a.db.execute(sql`select count(*)::int as n from ${sql.identifier(a.testDb.outboxSchema)}.audit_outbox`);
  return (r.rows[0] as { n: number }).n;
}
const readyz = (a: TestApp) => a.inject({ method: "GET", url: "/readyz" });

describe("readiness", () => {
  it("is 503 until a drain pass has succeeded", async () => {
    expect(app.drainer.passes()).toBe(0);
    expect(app.drainer.lastPassAt).toBeNull();
    expect(app.drainer.lastPassOk).toBe(false);
    expect(app.drainer.listening()).toBe(false);
    const r = await readyz(app);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.message).toContain("drainer - no drain pass has succeeded yet");
  });

  it("is 200 after a pass, and 503 again once the last good pass is more than 30 s old", async () => {
    await app.drainer.drainNow();
    expect(app.drainer.lastPassOk).toBe(true);
    expect((await readyz(app)).statusCode).toBe(200);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + READY_STALE_MS + 1000);
      const r = await readyz(app);
      expect(r.statusCode).toBe(503);
      expect(r.json().error.message).toMatch(/drainer - the last successful drain pass was 3\d s ago/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a failed pass without losing readiness while a good pass is recent", async () => {
    await app.drainer.drainNow();
    drain.mode = "fail";
    const before = app.drainer.passes();
    await app.drainer.drainNow();
    expect(app.drainer.passes()).toBe(before + 1);
    expect(app.drainer.lastPassOk).toBe(false);
    expect(app.drainer.lastPassAt).not.toBeNull();
    expect((await readyz(app)).statusCode).toBe(200);

    drain.mode = "real";
    await app.drainer.drainNow();
    expect(app.drainer.lastPassOk).toBe(true);
  });
});

describe("passes", () => {
  it("passes again at once while a pass fills its batch", async () => {
    const tag = randomUUID();
    await putOutbox(app.testDb, tagged(tag, 12));
    const passes = app.drainer.passes();
    const stored = await metric(app, "audit_events_stored_total");

    await app.drainer.drainNow();

    // 5 (full) → 5 (full) → 2 (short): three passes from one request, and the outbox is empty.
    expect(app.drainer.passes() - passes).toBe(3);
    expect(await outboxDepth(app)).toBe(0);
    expect(await storedCount(app, tag)).toBe(12);
    expect((await metric(app, "audit_events_stored_total")) - stored).toBe(12);
  });

  it("reports outbox depth, drain lag, stored events and dead letters on /metrics", async () => {
    const tag = randomUUID();
    drain.mode = "idle";
    await putOutbox(app.testDb, tagged(tag, 3));
    await app.drainer.drainNow();
    expect(await metric(app, "audit_outbox_depth")).toBe(3);
    expect(await metric(app, "audit_drain_lag_seconds")).toBeGreaterThan(0);

    drain.mode = "real";
    await putOutbox(app.testDb, ["not an event"]);
    const stored = await metric(app, "audit_events_stored_total");
    const dead = await metric(app, "audit_dead_letters_total");
    await app.drainer.drainNow();
    expect((await metric(app, "audit_events_stored_total")) - stored).toBe(3);
    expect((await metric(app, "audit_dead_letters_total")) - dead).toBe(1);
    expect(await metric(app, "audit_outbox_depth")).toBe(0);
    expect(await metric(app, "audit_drain_lag_seconds")).toBe(0);
    expect(await metric(app, "audit_listener_up")).toBe(0);   // this app never listens
  });
});

describe("listener", () => {
  const name = () => `rch-audit-drainer ${live.config.auditSchema}`;
  async function listenerPid(): Promise<number | null> {
    const r = await app.db.execute(sql`select pid from pg_stat_activity where application_name = ${name()}`);
    return (r.rows[0] as { pid: number } | undefined)?.pid ?? null;
  }
  /** What the API sends after an outbox insert: its outbox schema's name as the payload (D14). */
  async function notify(payload: string): Promise<void> {
    await app.db.execute(sql`select pg_notify(${AUDIT_OUTBOX_CHANNEL}, ${payload})`);
  }

  it("has passed once by the time ready() resolves, and drains on a notification naming its outbox", async () => {
    expect(live.drainer.passes()).toBeGreaterThanOrEqual(1);
    expect((await readyz(live)).statusCode).toBe(200);
    expect(await waitFor(() => live.drainer.listening(), 5000)).toBe(true);
    expect(await metric(live, "audit_listener_up")).toBe(1);

    const tag = randomUUID();
    await putOutbox(live.testDb, tagged(tag, 3));
    await notify(live.config.outboxSchema);

    // The poll is a minute away; only the notification can explain this.
    expect(await waitFor(async () => (await storedCount(live, tag)) === 3, 2000)).toBe(true);
  });

  it("ignores a notification naming another outbox, and wakes on an empty one", async () => {
    const tag = randomUUID();
    await putOutbox(live.testDb, tagged(tag, 2));
    await notify("some_other_outbox_schema");
    await settle(700);
    expect(await storedCount(live, tag)).toBe(0);

    await notify("");
    expect(await waitFor(async () => (await storedCount(live, tag)) === 2, 2000)).toBe(true);
  });

  it("comes back from a cut LISTEN connection and still wakes on a notification", async () => {
    expect(await waitFor(() => live.drainer.listening(), 5000)).toBe(true);
    const old = await listenerPid();
    expect(old).not.toBeNull();

    await app.db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${name()}`);

    expect(await waitFor(async () => {
      const pid = await listenerPid();
      return live.drainer.listening() && pid !== null && pid !== old;
    }, 20_000)).toBe(true);
    expect(await metric(live, "audit_listener_up")).toBe(1);

    const tag = randomUUID();
    await putOutbox(live.testDb, tagged(tag, 2));
    await notify(live.config.outboxSchema);
    expect(await waitFor(async () => (await storedCount(live, tag)) === 2, 2000)).toBe(true);
  });

  it("gives its LISTEN connection back on close", async () => {
    expect(await listenerPid()).not.toBeNull();
    await live.close();
    liveClosed = true;
    expect(await waitFor(async () => (await listenerPid()) === null, 2000)).toBe(true);
  });

  it("keeps trying to listen while the database refuses it, still drains through the pool, and closes promptly", async () => {
    // The harness hands the app its own pool, so only the LISTEN client uses this unreachable URL.
    const down = await buildTestApp({ schema: "drainer_down", drainer: true, env: { AUDIT_DATABASE_URL: "postgres://rch:rch@127.0.0.1:1/none" } });
    let closed = false;
    try {
      await down.ready();
      expect(down.drainer.passes()).toBeGreaterThanOrEqual(1);
      expect(down.drainer.lastPassOk).toBe(true);
      await settle(700);                                  // long enough for two retries on the backoff
      expect(down.drainer.listening()).toBe(false);
      expect(await metric(down, "audit_listener_up")).toBe(0);
      const started = Date.now();
      await down.close();
      closed = true;
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      if (!closed) await down.close();
    }
  });
});
