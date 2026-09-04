import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
  return {
    res,
    close: () => ac.abort(),
    /** Read until `want(buf)` is true, or throw after 4 s so a hang fails loudly. */
    async until(want: (b: string) => boolean): Promise<string> {
      const stop = Date.now() + 4000;
      while (!want(buf)) {
        if (Date.now() > stop) throw new Error(`timed out waiting; buffer was:\n${buf}`);
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      return buf;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 250));

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

    const r = await fetch(base + API_PREFIX + "/availability/toggle", {
      method: "POST",
      headers: { ...(await authHeaders(app, "u1")), "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ loc: "coffee", it: "juice" }),
    });
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
    expect(await s.until(() => true)).not.toContain("event: changed");
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

    await shutting.close();     // must not hang on the open stream

    for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
    expect(buf).toContain("retry:");    // the browser is told when to come back
  }, 20_000);
});
