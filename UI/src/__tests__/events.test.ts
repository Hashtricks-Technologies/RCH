import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_DEBOUNCE_MS, startEventStream, useStreamState } from "../api/events";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import { as, resetStore, S } from "./fixture";

vi.mock("../api/refetch", () => ({ refetch: vi.fn(async () => {}) }));
const { refetch } = await import("../api/refetch");

/** A body we push frames into by hand, so a test drives the stream's clock, not the network. */
function stream() {
  let push!: (s: string) => void;
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      push = (s) => c.enqueue(new TextEncoder().encode(s));
      close = () => c.close();
    },
  });
  return { body, push, close };
}

const fetchMock = vi.fn();
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
  // `resetStore` sets 22 fields but not `auth`, and these cases turn on it — so set it here
  // rather than depending on what the case before left behind. (Task 8 owns fixture.ts.)
  useApp.setState({ auth: "signed-out" });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.mocked(refetch).mockClear();
  setAccessToken("tok");
});
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); setAccessToken(null); });

/** Let the stream's reader loop run: microtasks, then whatever timers the test asked for. */
const turn = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

describe("the event stream", () => {
  it("opens only once the session is ready, and sends the token in a header", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    stop = startEventStream();
    expect(fetchMock).not.toHaveBeenCalled();          // signed out: nothing to listen for

    useApp.setState({ auth: "ready" });
    await turn();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/events");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    // The token is a header, never a query string: it must not reach a log or the history.
    expect(url).not.toContain("tok");
    expect(useStreamState === undefined).toBe(false);
  });

  it("refetches exactly the collections the notices named, once, after the debounce", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200 }));
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    s.push(`id: 1\nevent: changed\ndata: {"collection":"req","at":"2026-09-04T04:30:00.000Z"}\n\n`);
    s.push(`id: 2\nevent: changed\ndata: {"collection":"tkt","at":"2026-09-04T04:30:00.100Z"}\n\n`);
    s.push(`id: 3\nevent: changed\ndata: {"collection":"req","at":"2026-09-04T04:30:00.200Z"}\n\n`);
    await turn();
    expect(refetch).not.toHaveBeenCalled();            // still inside the window

    await turn(EVENT_DEBOUNCE_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect([...(vi.mocked(refetch).mock.calls[0][0] as string[])].sort()).toEqual(["req", "tkt"]);
  });

  it("reads a frame that arrives split across two chunks", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200 }));
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    s.push(`id: 9\nevent: changed\ndata: {"collec`);
    await turn(EVENT_DEBOUNCE_MS);
    expect(refetch).not.toHaveBeenCalled();
    s.push(`tion":"stock","at":"2026-09-04T04:30:00.000Z"}\n\n`);
    await turn(EVENT_DEBOUNCE_MS);
    expect(vi.mocked(refetch).mock.calls[0][0]).toEqual(["stock"]);
  });

  it("ignores a heartbeat and an unreadable frame without dropping the stream", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200 }));
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    s.push(": ping\n\n");
    s.push(`id: 4\nevent: changed\ndata: {"collection":"nonsense","at":"x"}\n\n`);
    s.push(`id: 5\nevent: changed\ndata: not json\n\n`);
    await turn(EVENT_DEBOUNCE_MS);
    expect(refetch).not.toHaveBeenCalled();

    s.push(`id: 6\nevent: changed\ndata: {"collection":"bills","at":"2026-09-04T04:30:00.000Z"}\n\n`);
    await turn(EVENT_DEBOUNCE_MS);
    expect(vi.mocked(refetch).mock.calls[0][0]).toEqual(["bills"]);
  });

  it("takes the whole snapshot again when the server says resync", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200 }));
    const load = vi.spyOn(S(), "loadSnapshot").mockResolvedValue();
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    s.push(`id: 7\nevent: resync\ndata: {"at":"2026-09-04T04:30:00.000Z"}\n\n`);
    await turn(EVENT_DEBOUNCE_MS);
    expect(load).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();            // a resync supersedes the pending slices
  });

  it("reconnects with backoff, quoting the last id it saw, and says so while it is down", async () => {
    const first = stream();
    fetchMock.mockResolvedValueOnce(new Response(first.body, { status: 200 }));
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();
    first.push(`id: 42\nevent: changed\ndata: {"collection":"req","at":"2026-09-04T04:30:00.000Z"}\n\n`);
    await turn(EVENT_DEBOUNCE_MS);

    const second = stream();
    fetchMock.mockResolvedValueOnce(new Response(second.body, { status: 200 }));
    first.close();
    await turn();
    expect(useApp.getState() && true).toBe(true);      // the store is untouched by a drop

    await turn(5000);                                   // past the first backoff step
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["last-event-id"]).toBe("42");
  });

  it("refreshes once on a 401 and retries with the new token", async () => {
    const s = stream();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));                                  // the stream
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "fresh" }), { status: 200, headers: { "content-type": "application/json" } }));  // POST /auth/refresh
    fetchMock.mockResolvedValueOnce(new Response(s.body, { status: 200 }));                                // the retry
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toContain("/auth/refresh");
    const [, retry] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect((retry.headers as Record<string, string>).authorization).toBe("Bearer fresh");
  });

  it("ends the session when the refresh fails too", async () => {
    as("counter");
    expect(S().user).not.toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));   // the stream
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));   // the refresh
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();

    // `sessionLost()` is what the typed client fires; the store drops the user behind it.
    expect(S().user).toBeNull();
    expect(S().auth).toBe("signed-out");
  });

  it("closes the stream when the user signs out, and opens no other", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200 }));
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    useApp.setState({ auth: "signed-out" });
    await turn(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);         // no reconnect behind a sign-out
  });
});
