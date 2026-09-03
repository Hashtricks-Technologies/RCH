import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import type { User } from "../types";

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const USER: User = {
  id: "u1", n: "Kavitha Raman", e: "kavitha.r@royalcare.in", r: "counter",
  rl: "Counter Operator", loc: "coffee", col: "#B45309", emp: "RC-4471", ph: "98430 22118",
};

/** The smallest body `applySnapshot` will accept — this suite is about the session, not the data. */
const SNAPSHOT = {
  user: USER, items: {}, locations: {}, recipes: {}, users: [USER],
  stock: { coffee: {} }, rsv: {}, ovr: {}, prices: { A: {}, B: {} }, menu: {},
  req: [], tkt: [], prq: [], po: [], pord: [], batch: [], bills: [], grn: [],
  vendors: [], contracts: [], tickets: [], productReqs: [], shopAsks: [],
  sales: [], dayLabels: [],
};

describe("restoring the session at boot", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    setAccessToken(null);
    useApp.setState({ user: null, auth: "signed-out", mustChangePassword: false, toast: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("signs the user back in from the refresh cookie and loads the snapshot", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ accessToken: "new", user: USER, mustChangePassword: false }))
      .mockResolvedValueOnce(ok(SNAPSHOT));
    await useApp.getState().restore();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/refresh");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/snapshot");
    expect(useApp.getState().user?.id).toBe("u1");
    expect(useApp.getState().auth).toBe("ready");
  });

  it("falls back to the sign-in screen in silence when there is no cookie", async () => {
    fetchMock.mockResolvedValueOnce(ok({ error: { code: "unauthenticated", message: "Sign in to continue." } }, 401));
    await useApp.getState().restore();
    // The refresh must not be retried: /auth/ routes are exempt from the retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useApp.getState().auth).toBe("signed-out");
    expect(useApp.getState().user).toBeNull();
    // A first-time visitor never had a session; telling them one ended would be a lie.
    expect(useApp.getState().toast).toBeNull();
  });

  it("leaves a session that is already signed in alone", async () => {
    setAccessToken("tok");
    useApp.setState({ user: USER, auth: "ready" });
    await useApp.getState().restore();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useApp.getState().auth).toBe("ready");
  });
});
