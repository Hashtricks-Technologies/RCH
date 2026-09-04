import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { sql } from "drizzle-orm";
import { API_PREFIX, EVENTS_PATH } from "@rch/contract";
import { buildTestApp } from "../test/app.js";
import { seedTestDb } from "../test/seed.js";
import { authHeaders } from "../test/auth.js";
import type { App } from "../app.js";

let app: App;
let base: string;

beforeAll(async () => {
  app = await buildTestApp({ schema: "sse", env: { SSE_HEARTBEAT_MS: "80" } });
  await seedTestDb(app.testDb!.db);
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const a = app.server.address() as { port: number };
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(async () => { await app.close(); });

/** One open stream, with a reader that hands back frames as they arrive. */
async function open(userId: string, extra: Record<string, string> = {}) {
  const ac = new AbortController();
  const res = await fetch(base + API_PREFIX + EVENTS_PATH, {
    headers: { ...(await authHeaders(app, userId)), accept: "text/event-stream", ...extra },
    signal: ac.signal,
  });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let pending: ReturnType<typeof reader.read> | null = null;

  /** One read at a time, kept across calls: a chunk that arrives after `drain` gave up waiting
   *  must still reach the buffer, or the next assertion reads a hole where a frame was. */
  async function pump(deadline: number): Promise<boolean> {
    pending ??= reader.read();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<null>((k) => { timer = setTimeout(() => k(null), Math.max(0, deadline - Date.now())); });
    const r = await Promise.race([pending, expired]);
    clearTimeout(timer);
    if (r === null) return false;
    pending = null;
    if (r.done) return false;
    buf += dec.decode(r.value, { stream: true });
    return true;
  }

  return {
    res,
    close: () => ac.abort(),
    /** Everything read so far, without waiting for more. */
    seen: () => buf,
    /** Read until `want(buf)` is true, or throw after `ms` so a hang fails loudly. */
    async until(want: (b: string) => boolean, ms = 4000): Promise<string> {
      const stop = Date.now() + ms;
      while (!want(buf)) {
        if (Date.now() > stop) break;
        if (!(await pump(stop))) break;
      }
      if (!want(buf)) throw new Error(`timed out waiting; buffer was:\n${buf}`);
      return buf;
    },
    /** Read whatever arrives for `ms`, then hand back everything seen. Used where the point is
     *  that nothing more arrives, or that exactly one thing does. */
    async drain(ms: number): Promise<string> {
      const stop = Date.now() + ms;
      while (Date.now() < stop && await pump(stop)) { /* keep reading */ }
      return buf;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 250));
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/** The listener names itself after the schema it listens on, so `pg_stat_activity` can be asked
 *  about one connection and not every other suite's. */
const listenerName = () => `rch-api-events ${app.testDb!.schemaName}`;
async function listenerBackends(): Promise<number> {
  const r = await app.db.execute(sql`select count(*)::int as n from pg_stat_activity where application_name = ${listenerName()}`);
  return (r.rows[0] as { n: number }).n;
}
const toggleJuice = async () => fetch(base + API_PREFIX + "/availability/toggle", {
  method: "POST",
  headers: { ...(await authHeaders(app, "u1")), "content-type": "application/json", "idempotency-key": randomUUID() },
  body: JSON.stringify({ loc: "coffee", it: "juice" }),
});

describe("GET /events", () => {
  it("refuses an unauthenticated stream with the JSON envelope, not a stream", async () => {
    const r = await fetch(base + API_PREFIX + EVENTS_PATH);
    expect(r.status).toBe(401);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("unauthenticated");
  });

  it("opens with the streaming headers and a retry hint", async () => {
    const s = await open("u1");
    expect(s.res.headers.get("content-type")).toContain("text/event-stream");
    expect(s.res.headers.get("cache-control")).toContain("no-cache");
    expect(s.res.headers.get("x-accel-buffering")).toBe("no");
    await s.until((b) => b.includes("retry:"));
    s.close();
  });

  it("tells every open stream what a committed write changed, on every connection", async () => {
    const a = await open("u1");
    const b = await open("u2");
    await a.until((x) => x.includes("retry:"));
    await b.until((x) => x.includes("retry:"));

    const r = await toggleJuice();
    expect(r.status).toBe(200);

    for (const s of [a, b]) {
      const buf = await s.until((x) => x.includes("event: changed"));
      const frame = buf.split("\n\n").find((f) => f.includes("event: changed"))!;
      expect(frame).toMatch(/^id: \d+$/m);
      expect(JSON.parse(/^data: (.*)$/m.exec(frame)![1])).toEqual({ collection: "ovr", at: expect.any(String) });
    }
    a.close(); b.close();
  });

  it("says nothing when a write is refused", async () => {
    const s = await open("u1");
    await s.until((x) => x.includes("retry:"));
    const r = await fetch(base + API_PREFIX + "/availability/toggle", {
      method: "POST",
      headers: { ...(await authHeaders(app, "u1")), "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ loc: "coffee", it: "totally-fake" }),
    });
    expect(r.status).toBe(404);
    await settle();
    expect(await s.drain(250)).not.toContain("event: changed");
    s.close();
  });

  it("keeps the socket open past the heartbeat, and comments on it", async () => {
    const s = await open("u1");
    const buf = await s.until((x) => x.includes(": ping"));
    expect(buf).toContain(": ping");
    s.close();
  });

  it("resyncs a reconnecting client instead of replaying history", async () => {
    const s = await open("u1", { "last-event-id": "17" });
    const buf = await s.until((x) => x.includes("event: resync"));
    expect(buf).toContain("event: resync");
    s.close();
  });

  it("drops a notice it cannot read, and goes on listening", async () => {
    const s = await open("u1");
    await s.until((x) => x.includes("retry:"));
    const before = s.seen();
    // The channel belongs to the database, so anything with a connection can write to it.
    // None of these should reach a browser.
    for (const payload of ["not json at all", '{"collections":["nosuchslice"],"at":"now"}', '{"collections":[],"at":"now"}', '{"at":"now"}']) {
      await app.db.execute(sql`select pg_notify('rch_events_' || current_schema(), ${payload})`);
    }
    expect((await s.drain(500)).slice(before.length)).not.toContain("event: changed");

    // Still listening: a real write straight afterwards is announced as usual.
    const mark = s.seen();
    expect((await toggleJuice()).status).toBe(200);
    const tail = (await s.until((x) => x.slice(mark.length).includes("event: changed"))).slice(mark.length);
    expect(JSON.parse(/^data: (.*)$/m.exec(tail.split("\n\n").find((f) => f.includes("event: changed"))!)![1]))
      .toEqual({ collection: "ovr", at: expect.any(String) });
    s.close();
  });

  it("caps one person's open streams, and refuses the ninth with a sentence and not a stream", async () => {
    // The route turns the global rate limiter off (a request that lasts an hour is the wrong
    // shape for a per-minute budget), so this cap is the only thing standing between a browser
    // stuck in a reconnect loop and a socket per attempt. Eight is far above a real counter.
    await settle();                                        // sockets aborted by earlier cases close asynchronously
    const held = [];
    for (let i = 0; i < 8; i++) {
      const s = await open("u5");
      await s.until((x) => x.includes("retry:"));
      held.push(s);
    }

    const ninth = await fetch(base + API_PREFIX + EVENTS_PATH, { headers: { ...(await authHeaders(app, "u5")), accept: "text/event-stream" } });
    expect(ninth.status).toBe(429);
    expect(ninth.headers.get("content-type")).toContain("application/json");
    expect(await ninth.json()).toEqual({
      error: { code: "rate_limited", message: "You already have 8 screens listening for updates. Close one and try again." },
    });
    // The cap is one person's, not the pod's: somebody else still gets their stream.
    const other = await open("u3");
    await other.until((x) => x.includes("retry:"));
    other.close();

    // And a slot comes back when a stream closes.
    held.pop()!.close();
    await settle();
    const again = await open("u5");
    await again.until((x) => x.includes("retry:"));
    again.close();
    for (const s of held) s.close();
    await settle();
  });

  it("counts open streams in /metrics", async () => {
    await settle();      // sockets aborted by earlier cases close asynchronously
    const a = await open("u1");
    const b = await open("u2");
    await a.until((x) => x.includes("retry:"));
    await b.until((x) => x.includes("retry:"));
    const m = await (await fetch(base + "/metrics")).text();
    expect(m).toMatch(/^sse_clients 2$/m);
    expect(m).toMatch(/^sse_listener_up 1$/m);
    a.close(); b.close();
    await settle();
    expect(await (await fetch(base + "/metrics")).text()).toMatch(/^sse_clients 0$/m);
  });

  it("comes back from a cut connection, resyncs, and still delivers each notice once", async () => {
    const s = await open("u1");
    await s.until((x) => x.includes("retry:"));
    expect(app.sse.listeners()).toBe(1);
    expect(await listenerBackends()).toBe(1);

    // Cut it the way a failover does.
    for (let i = 0; i < 4; i++) {
      await app.db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${listenerName()}`);
      await new Promise((r) => setTimeout(r, 60));
    }
    const healthy = async () =>
      app.sse.listeners() === 1
      && (await listenerBackends()) === 1
      && /^sse_listener_up 1$/m.test(await (await fetch(base + "/metrics")).text());
    const stop = Date.now() + 20_000;
    while (Date.now() < stop && !(await healthy())) await new Promise((r) => setTimeout(r, 100));
    expect(app.sse.listeners()).toBe(1);
    expect(await listenerBackends()).toBe(1);

    const mark = s.seen();
    expect((await toggleJuice()).status).toBe(200);
    const buf = await s.drain(1500);
    // One listener, one delivery. A second one hears the same channel, and the browser is told
    // twice to refetch the same slice.
    expect(count(buf.slice(mark.length), "event: changed")).toBe(1);
    // And it was told to take everything again when the listener came back, because notices
    // raised while it was down are gone.
    expect(buf).toContain("event: resync");
    s.close();
  }, 40_000);
});

/**
 * A Postgres ErrorResponse, framed the way the server frames one. Written onto a socket the
 * relay then holds open, it is the black-holed connection the reconnect guard exists for: the
 * pod has been told its connection is dead, and cannot finish letting go of it.
 * `pg_terminate_backend` cannot produce that — it closes the socket in the same breath.
 */
function pgFatal(code: string, message: string): Buffer {
  const fields = Buffer.from(`SFATAL\0VFATAL\0C${code}\0M${message}\0\0`, "utf8");
  const out = Buffer.alloc(5 + fields.length);
  out.write("E", 0, "ascii");
  out.writeInt32BE(4 + fields.length, 1);
  fields.copy(out, 5);
  return out;
}

const PG_URL = () => process.env.TEST_DATABASE_URL ?? "postgres://rch:rch@localhost:5439/rch_test";

describe("the listener's own connection", () => {
  it("gives its backend back when the pod stops", async () => {
    const pod = await buildTestApp({ schema: "sse_stop" });
    await pod.ready();
    const name = `rch-api-events ${pod.testDb!.schemaName}`;
    // Counted from *this* file's app: the stopping one takes its own pool with it.
    const backends = async () =>
      ((await app.db.execute(sql`select count(*)::int as n from pg_stat_activity where application_name = ${name}`)).rows[0] as { n: number }).n;
    expect(pod.sse.listeners()).toBe(1);
    expect(await backends()).toBe(1);
    await pod.close();
    expect(pod.sse.listeners()).toBe(0);
    const stop = Date.now() + 5000;
    while (Date.now() < stop && (await backends()) > 0) await new Promise((r) => setTimeout(r, 50));
    expect(await backends()).toBe(0);
  }, 30_000);

  // This one holds the line for a case pg cannot currently reach: `Client.end()` force-destroys
  // the socket once an async error has made the client unqueryable (pg/lib/client.js), so today
  // a replaced connection always lets go at once. If that ever changes — a graceful `end()` on a
  // black-holed socket, finishing minutes later — this is the test that catches the second
  // listener it would otherwise start.
  it("does not start a second one when a connection it already replaced finally lets go", async () => {
    const upstream = new URL(PG_URL());
    const pairs: { down: net.Socket; up: net.Socket }[] = [];
    // allowHalfOpen, and copied by hand rather than piped: `pipe` tears the other half down
    // with it, and the whole point here is a socket that stays open after the listener has
    // said goodbye, so its `end()` cannot finish while the reconnect goes ahead without it.
    const relay = net.createServer({ allowHalfOpen: true }, (down) => {
      const up = net.createConnection({ host: upstream.hostname, port: Number(upstream.port || 5432) });
      pairs.push({ down, up });
      down.on("data", (b) => { if (up.writable) up.write(b); });
      up.on("data", (b) => { if (down.writable) down.write(b); });
      down.on("error", () => {}); up.on("error", () => {});
    });
    await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
    const relayed = new URL(upstream.toString());
    relayed.host = `127.0.0.1:${(relay.address() as net.AddressInfo).port}`;

    // No stream and no seed: this is about the listener, and it connects at build time.
    const pod = await buildTestApp({ schema: "sse_relay", env: { DATABASE_URL: relayed.toString(), SSE_HEARTBEAT_MS: "5000" } });
    // Finish the boot: avvio arms a 10 s plugin timeout, and this test waits longer than that.
    await pod.ready();
    try {
      const name = `rch-api-events ${pod.testDb!.schemaName}`;
      const backends = async () =>
        ((await pod.db.execute(sql`select count(*)::int as n from pg_stat_activity where application_name = ${name}`)).rows[0] as { n: number }).n;
      expect(pod.sse.listeners()).toBe(1);
      expect(await backends()).toBe(1);

      // Kill the connection from the far side and tell the listener so, without ever letting
      // its socket finish closing.
      const first = pairs[0];
      first.up.destroy();
      first.down.write(pgFatal("57P01", "terminating connection due to administrator command"));

      // It reconnects on the 250 ms backoff, and that one is healthy.
      const stop = Date.now() + 10_000;
      while (Date.now() < stop && !(pairs.length === 2 && (await backends()) === 1)) await new Promise((r) => setTimeout(r, 50));
      expect(pairs).toHaveLength(2);
      expect(pod.sse.listeners()).toBe(1);
      expect(await backends()).toBe(1);

      // Now the first connection finally lets go. Its 'end' says nothing about the live one:
      // acting on it would start a second listener and leave this one hearing the channel too.
      first.down.destroy();
      await new Promise((r) => setTimeout(r, 1500));
      expect(pod.sse.listeners()).toBe(1);
      expect(await backends()).toBe(1);
    } finally {
      // Sockets first: this relay deliberately does not pass a close through, so a graceful
      // end would sit there waiting for a FIN that is never coming.
      for (const p of pairs) { p.down.destroy(); p.up.destroy(); }
      await pod.close();
      await new Promise<void>((r) => relay.close(() => r()));
    }
  }, 30_000);
});

describe("shutdown", () => {
  it("ends every stream with a retry hint rather than dropping the socket", async () => {
    const shutting = await buildTestApp({ schema: "sse_close", env: { SSE_HEARTBEAT_MS: "80" } });
    await seedTestDb(shutting.testDb!.db);
    await shutting.ready();
    await shutting.listen({ port: 0, host: "127.0.0.1" });
    const port = (shutting.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}${API_PREFIX}${EVENTS_PATH}`, {
      headers: { ...(await authHeaders(shutting, "u1")), accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const first = await reader.read();
    buf += dec.decode(first.value, { stream: true });
    // Every stream opens with one; the assertion below is about the *second*, so count first.
    const opening = count(buf, "retry:");
    expect(opening).toBe(1);

    await shutting.close();     // must not hang on the open stream

    for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
    // The socket is not dropped: it is ended with a fresh hint about when to come back.
    expect(count(buf, "retry:")).toBe(opening + 1);
  }, 20_000);
});
