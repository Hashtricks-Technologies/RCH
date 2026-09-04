import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { EVENT_DEBOUNCE_MS, startEventStream, useStreamState, type StreamState } from "../api/events";
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

/**
 * The shell's connection pill, mounted for real. `useStreamState` is a subscription, so the
 * only honest way to read what the operator is being told is to render something that uses it
 * — reading the module's variable would prove the module talks to itself.
 */
function mountPill() {
  // Written in an effect, not during the render: what a committed render actually put on the
  // screen is what the operator sees, and it is the only thing worth asserting on.
  const shown: { state?: StreamState } = {};
  const Pill = () => {
    const state = useStreamState();
    useEffect(() => { shown.state = state; }, [state]);
    return null;
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(Pill)); });
  return {
    /** Let React settle whatever the stream just told it, then read what the pill shows. */
    async read(): Promise<StreamState | undefined> { await act(async () => {}); return shown.state; },
    unmount() { act(() => { root.unmount(); }); host.remove(); },
  };
}

const fetchMock = vi.fn();
let stop: (() => void) | undefined;
let pill: ReturnType<typeof mountPill> | undefined;

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
afterEach(() => {
  pill?.unmount(); pill = undefined;
  stop?.(); stop = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); setAccessToken(null);
});

/** Let the stream's reader loop run: microtasks, then whatever timers the test asked for. */
const turn = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

describe("the event stream", () => {
  it("opens only once the session is ready, and sends the token in a header", async () => {
    const s = stream();
    fetchMock.mockResolvedValue(new Response(s.body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    pill = mountPill();
    stop = startEventStream();
    expect(fetchMock).not.toHaveBeenCalled();          // signed out: nothing to listen for
    expect(await pill.read()).toBe("off");             // and the shell says so

    useApp.setState({ auth: "ready" });
    await turn();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/events");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    // The token is a header, never a query string: it must not reach a log or the history.
    expect(url).not.toContain("tok");
    expect(await pill.read()).toBe("live");
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
    pill = mountPill();
    stop = startEventStream();
    useApp.setState({ auth: "ready" });
    await turn();
    first.push(`id: 42\nevent: changed\ndata: {"collection":"req","at":"2026-09-04T04:30:00.000Z"}\n\n`);
    await turn(EVENT_DEBOUNCE_MS);
    expect(await pill.read()).toBe("live");
    // The documents the shell is showing while the stream drops and comes back. A drop must
    // not disturb them: the refetch that follows a reconnect is what replaces them, and until
    // it lands the operator keeps reading exactly what they were reading.
    const tkt = S().tkt;
    expect(tkt.length).toBeGreaterThan(0);

    const second = stream();
    fetchMock.mockResolvedValueOnce(new Response(second.body, { status: 200 }));
    first.close();
    await turn();
    expect(await pill.read()).toBe("reconnecting");     // the shell tells the operator it is down
    expect(S().tkt).toBe(tkt);                          // same array, not merely an equal one

    await turn(5000);                                   // past the first backoff step
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["last-event-id"]).toBe("42");
    expect(await pill.read()).toBe("live");
    expect(S().tkt).toBe(tkt);
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
