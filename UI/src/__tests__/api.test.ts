import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes, defineRoute } from "@rch/contract";
import { z } from "zod";
import { ApiError, call } from "../api/client";
import { setAccessToken, getAccessToken, sessionLost } from "../api/session";
import { fromInputDate, fromWireBestBefore, fromWireDate, fromWireTime, toInputDate } from "../lib/fmt";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("api client", () => {
  const fetchMock = vi.fn();
  beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); setAccessToken(null); });
  afterEach(() => vi.unstubAllGlobals());

  it("builds the url, sends the token and cookies, and parses the body", async () => {
    setAccessToken("tok");
    fetchMock.mockResolvedValueOnce(ok({ user: { id: "u1" }, mustChangePassword: false }));
    const r = await call(routes.me);
    expect(r.user.id).toBe("u1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/me");
    expect(init.credentials).toBe("include");
    expect(init.headers.authorization).toBe("Bearer tok");
  });
  it("substitutes path params and sends an Idempotency-Key on writes", async () => {
    setAccessToken("tok");
    const r = defineRoute({ method: "POST", path: "/things/:id/do", access: "any", params: z.object({ id: z.string() }), body: z.object({ n: z.number() }), response: z.object({ ok: z.literal(true) }) });
    fetchMock.mockResolvedValueOnce(ok({ ok: true }));
    await call(r, { params: { id: "X-1" }, body: { n: 2 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/things/X-1/do");
    expect(init.method).toBe("POST");
    expect(init.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.body).toBe(JSON.stringify({ n: 2 }));
  });
  // ---- bill void ----
  it("percent-encodes a path param that carries a slash", async () => {
    setAccessToken("tok");
    fetchMock.mockResolvedValueOnce(ok({ result: {}, changed: [], message: "CF/1188 voided" }));
    await call(routes.voidBill, { params: { no: "CF/1188" }, body: { reason: "Wrong tender" } });
    // A bare slash would split into two path segments and match no route at all - the server's
    // own suite pins the 404 from the other side. nginx forwards the encoded form unchanged.
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/bills/CF%2F1188/void");
  });
  it("refreshes once on 401 and retries with the new token", async () => {
    setAccessToken("old");
    fetchMock
      .mockResolvedValueOnce(ok({ error: { code: "unauthenticated", message: "expired" } }, 401))
      .mockResolvedValueOnce(ok({ accessToken: "new", user: { id: "u1" }, mustChangePassword: false }))
      .mockResolvedValueOnce(ok({ user: { id: "u1" }, mustChangePassword: false }));
    await call(routes.me);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/auth/refresh");
    expect(fetchMock.mock.calls[2][1].headers.authorization).toBe("Bearer new");
    expect(getAccessToken()).toBe("new");
  });
  it("reuses one Idempotency-Key across the refresh retry", async () => {
    setAccessToken("old");
    const write = defineRoute({ method: "POST", path: "/things/do", access: "any", body: z.object({ n: z.number() }), response: z.object({ ok: z.literal(true) }) });
    fetchMock
      .mockResolvedValueOnce(ok({ error: { code: "unauthenticated", message: "expired" } }, 401))
      .mockResolvedValueOnce(ok({ accessToken: "new", user: { id: "u1" }, mustChangePassword: false }))
      .mockResolvedValueOnce(ok({ ok: true }));
    await call(write, { body: { n: 1 } });
    const [first, , retry] = fetchMock.mock.calls.map((c) => c[1]);
    // A second key would present the retry as a brand-new write, and the server would run it
    // again - the one thing the header exists to prevent.
    expect(first.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(retry.headers["idempotency-key"]).toBe(first.headers["idempotency-key"]);
    expect(retry.headers.authorization).toBe("Bearer new");
  });
  it("surfaces the server's message as an ApiError", async () => {
    setAccessToken("tok");
    fetchMock.mockResolvedValueOnce(ok({ error: { code: "rule", message: "Not enough Milk 1L free to promise." } }, 422));
    await expect(call(routes.me)).rejects.toMatchObject({ code: "rule", message: "Not enough Milk 1L free to promise.", status: 422 });
  });
  it("turns a non-JSON error page into a readable ApiError", async () => {
    setAccessToken("tok");
    fetchMock.mockResolvedValueOnce(new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(call(routes.me)).rejects.toMatchObject({ code: "internal", message: "The server returned an unexpected response (502).", status: 502 });
  });

  it("stamps every call with an x-request-id", async () => {
    setAccessToken("tok");
    fetchMock.mockResolvedValueOnce(ok({ user: { id: "u1" }, mustChangePassword: false }));
    await call(routes.me);
    expect(fetchMock.mock.calls[0][1].headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("carries the request id the server echoed back on the error", async () => {
    setAccessToken("tok");
    // One id names the same request in the operator's sentence ("Reference <id>"), in the
    // API's own log line, and on whatever the support desk is handed afterwards.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "internal", message: "Something went wrong. Reference 9f1c." } }), {
      status: 500, headers: { "content-type": "application/json", "x-request-id": "9f1c" },
    }));
    await expect(call(routes.me)).rejects.toMatchObject({ requestId: "9f1c" });
  });

  it("falls back to the id it minted when the server echoes nothing", async () => {
    setAccessToken("tok");
    fetchMock.mockResolvedValueOnce(ok({ error: { code: "internal", message: "boom" } }, 500));
    const err = (await call(routes.me).catch((e: unknown) => e)) as ApiError;
    expect(err.requestId).toBe(fetchMock.mock.calls[0][1].headers["x-request-id"]);
  });
});

/**
 * Two tabs of one operator share one refresh cookie, and the server revokes the whole family
 * when a rotated token is presented twice. Without a cross-tab lock the second tab's refresh
 * loses the race and signs both of them out mid-shift.
 */
describe("api client - one refresh across tabs", () => {
  const fetchMock = vi.fn();
  let seen: string[] = [];

  class FakeChannel {
    static live: FakeChannel[] = [];
    name: string;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(name: string) { this.name = name; FakeChannel.live.push(this); }
    postMessage(data: unknown) { for (const c of FakeChannel.live) if (c !== this && c.name === this.name) c.onmessage?.({ data }); }
    close() { FakeChannel.live = FakeChannel.live.filter((c) => c !== this); }
  }

  /** A `navigator.locks` that actually serialises, so two waiters cannot both be inside. */
  let chain: Promise<unknown> = Promise.resolve();
  const locks = {
    request: vi.fn((_name: string, fn: () => Promise<unknown>) => {
      const run = chain.then(() => fn());
      chain = run.catch(() => undefined);
      return run;
    }),
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    // `live` is deliberately not cleared: the client opens its channel once and caches it, so
    // emptying the register between cases would leave that tab unreachable by a broadcast.
    chain = Promise.resolve();
    locks.request.mockReset();
    locks.request.mockImplementation((_name: string, fn: () => Promise<unknown>) => {
      const run = chain.then(() => fn());
      chain = run.catch(() => undefined);
      return run;
    });
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
    fetchMock.mockReset();
    seen = [];
    setAccessToken(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "locks");
    setAccessToken(null);
  });

  const serve = (refreshTo: string | null) => fetchMock.mockImplementation((u: string, init: RequestInit) => {
    seen.push(`${init.method} ${String(u)}`);
    if (String(u).endsWith("/auth/refresh")) {
      return Promise.resolve(refreshTo
        ? ok({ accessToken: refreshTo, user: { id: "u1" }, mustChangePassword: false })
        : ok({ error: { code: "unauthenticated", message: "no" } }, 401));
    }
    const headers = init.headers as Record<string, string>;
    return Promise.resolve(headers.authorization === "Bearer new" || headers.authorization === "Bearer from-tab-2"
      ? ok({ user: { id: "u1" }, mustChangePassword: false })
      : ok({ error: { code: "unauthenticated", message: "expired" } }, 401));
  });

  it("refreshes once when two calls 401 at the same time", async () => {
    setAccessToken("old");
    serve("new");

    await Promise.all([call(routes.me), call(routes.me)]);

    expect(seen.filter((x) => x.includes("/auth/refresh"))).toHaveLength(1);
    expect(locks.request).toHaveBeenCalledWith("rch-refresh", expect.any(Function));
  });

  it("adopts an access token another tab broadcast", async () => {
    setAccessToken("old");
    fetchMock.mockResolvedValueOnce(ok({ user: { id: "u1" }, mustChangePassword: false }));
    await call(routes.me);                      // the tab's channel opens with its first call

    new FakeChannel("rch-session").postMessage({ accessToken: "from-tab-2" });

    expect(getAccessToken()).toBe("from-tab-2");
  });

  it("skips the refresh when another tab replaced the token while this one waited", async () => {
    setAccessToken("old");
    // The lock is where the wait happens: by the time this tab is let in, tab 2 has refreshed
    // and broadcast. Refreshing again would present a rotated token twice and revoke the family.
    locks.request.mockImplementationOnce((_name: string, fn: () => Promise<unknown>) => {
      setAccessToken("from-tab-2");
      return fn();
    });
    serve("new");

    const r = await call(routes.me);

    expect(r.user.id).toBe("u1");
    expect(seen.filter((x) => x.includes("/auth/refresh"))).toHaveLength(0);
  });

  it("does not refresh again for a request that 401s after the first refresh landed (C2)", async () => {
    setAccessToken("old");
    fetchMock.mockImplementation((u: string, init: RequestInit) => {
      seen.push(`${init.method} ${String(u)}`);
      if (String(u).endsWith("/auth/refresh")) return Promise.resolve(ok({ accessToken: "new", user: { id: "u1" }, mustChangePassword: false }));
      const headers = init.headers as Record<string, string>;
      if (headers.authorization === "Bearer old") {
        // Another request's refresh lands while this one is still on the wire, so its own 401
        // is already stale by the time it arrives. Single-flight does not cover this gap -
        // `refreshing` is back to null - and refreshing again presents a rotated token twice.
        setAccessToken("new");
        return Promise.resolve(ok({ error: { code: "unauthenticated", message: "expired" } }, 401));
      }
      return Promise.resolve(ok({ user: { id: "u1" }, mustChangePassword: false }));
    });

    const r = await call(routes.me);

    expect(r.user.id).toBe("u1");                // retried on the token that was already there
    expect(seen.filter((x) => x.includes("/auth/refresh"))).toHaveLength(0);
  });

  it("tells the other tabs about the token it just minted", async () => {
    setAccessToken("old");
    const heard: unknown[] = [];
    const other = new FakeChannel("rch-session");
    other.onmessage = (e) => heard.push(e.data);
    serve("new");

    await call(routes.me);

    expect(heard).toEqual([{ accessToken: "new" }]);
  });

  // A broadcast is a *replacement* for a token this tab already holds, never a way to be handed
  // one. On a shared terminal the sign-in screen would otherwise pick up whoever is signed in
  // in the next tab and let the next person walk straight into their session.
  it("a signed-out tab ignores a token broadcast by another tab", async () => {
    setAccessToken(null);
    // A tab sitting on the sign-in screen still opens the channel - its own sign-in POST is a
    // `call()` like any other. /auth/ routes never refresh, so this is just the channel opening.
    fetchMock.mockResolvedValue(ok({ error: { code: "unauthenticated", message: "no" } }, 401));
    await call(routes.login, { body: { emp: "RC-4471", password: "wrong" } }).catch(() => undefined);

    new FakeChannel("rch-session").postMessage({ accessToken: "from-tab-2" });

    expect(getAccessToken()).toBeNull();
  });

  it("a tab whose session was lost does not adopt a broadcast token", async () => {
    setAccessToken("old");
    fetchMock.mockResolvedValueOnce(ok({ user: { id: "u1" }, mustChangePassword: false }));
    await call(routes.me);                      // the tab's channel opens with its first call

    sessionLost();                              // the family was revoked; this tab is done

    new FakeChannel("rch-session").postMessage({ accessToken: "from-tab-2" });

    expect(getAccessToken()).toBeNull();
  });

  it("refreshes without the lock when the browser will not grant one", async () => {
    setAccessToken("old");
    // `locks.request` rejects outright on a document that is not fully active
    // (InvalidStateError) or where the API is unavailable. The documented fallback is today's
    // behaviour - refresh anyway - not an unhandled rejection out of `call()`.
    locks.request.mockImplementation(() => Promise.reject(new Error("InvalidStateError")));
    serve("new");

    const r = await call(routes.me);

    expect(r.user.id).toBe("u1");
    expect(seen.filter((x) => x.includes("/auth/refresh"))).toHaveLength(1);
  });
});

describe("wire formats", () => {
  it("renders ISO instants as HH:MM in the hospital's zone", () => { expect(fromWireTime("2026-09-03T01:02:00.000Z")).toBe("06:32"); });
  it("renders dates as DD-MMM-YYYY", () => { expect(fromWireDate("2026-08-31")).toBe("31-Aug-2026"); });
  it("renders a best-before like bestBefore()", () => { expect(fromWireBestBefore(new Date(Date.now() + 3600_000).toISOString())).toMatch(/^\d{2}:\d{2}/); });
  it("computes the best-before day boundary in Asia/Kolkata, not the host's own zone", () => {
    // "now" is 2026-09-04T00:30 IST but still 2026-09-03 in UTC; the due instant is later the
    // same IST calendar day (2026-09-04T07:30 IST) though its UTC date bucket is already
    // 2026-09-04. A host-local/UTC day comparison would misread this pair as spanning a day
    // boundary and print "tomorrow" - it does not, in the hospital's own zone.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T19:00:00.000Z"));
    expect(fromWireBestBefore("2026-09-04T02:00:00.000Z")).toBe("07:30");
    vi.useRealTimers();
  });
});

describe("date controls", () => {
  it("round-trips a display date through an <input type=date> and back", () => {
    expect(toInputDate("31-Aug-2026")).toBe("2026-08-31");
    expect(fromInputDate("2026-08-31")).toBe("31-Aug-2026");
    expect(toInputDate(fromInputDate("2026-01-01"))).toBe("2026-01-01");
  });
  it("leaves a wire date alone and answers empty for anything it cannot read", () => {
    expect(toInputDate("2026-08-31")).toBe("2026-08-31");
    expect(toInputDate("")).toBe("");
    expect(toInputDate("tomorrow")).toBe("");
  });
});
