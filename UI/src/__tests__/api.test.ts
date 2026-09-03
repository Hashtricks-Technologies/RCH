import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes, defineRoute } from "@rch/contract";
import { z } from "zod";
import { ApiError, call } from "../api/client";
import { setAccessToken, getAccessToken } from "../api/session";
import { fromWireBestBefore, fromWireDate, fromWireTime } from "../lib/fmt";

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
    await expect(call(routes.me)).rejects.toMatchObject(new ApiError("rule", "Not enough Milk 1L free to promise.", 422));
  });
  it("turns a non-JSON error page into a readable ApiError", async () => {
    setAccessToken("tok");
    fetchMock.mockResolvedValueOnce(new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    await expect(call(routes.me)).rejects.toMatchObject(new ApiError("internal", "The server returned an unexpected response (502).", 502));
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
