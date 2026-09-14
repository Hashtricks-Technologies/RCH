import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, setAccessToken } from "../api/session";
import { useApp } from "../store";
import { hydrateMaster } from "../data/master";
import type { MasterData } from "../data/master";
import type { Location, User } from "../types";

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const USER: User = {
  id: "u1", n: "Kavitha Raman", e: "kavitha.r@royalcare.in", r: "counter",
  rl: "Counter Operator", loc: "coffee", col: "#B45309", emp: "RC-4471", ph: "98430 22118", admin: false,
};

/** The smallest body `applySnapshot` will accept - this suite is about the session, not the data. */
const SNAPSHOT = {
  user: USER, items: {}, locations: {}, recipes: {}, users: [USER],
  roster: { patients: [], staff: [], depts: [] },
  stock: { coffee: {} }, rsv: {}, ovr: {}, prices: { A: {}, B: {} }, menu: {},
  req: [], tkt: [], prq: [], po: [], pord: [], batch: [], bills: [], grn: [],
  vendors: [], contracts: [], tickets: [], productReqs: [], shopAsks: [],
  sales: [], dayLabels: [],
  // ---- adjustments
  adjustments: [],
};

/** An empty item master - the state a browser is in before its first snapshot lands. */
const EMPTY_MASTER: MasterData = {
  items: {}, locations: {}, recipes: {}, prices: { A: {}, B: {} }, menu: {}, users: [USER],
};
const COFFEE: Location = {
  n: "Floor 3 Coffee Bar", c: "Coffee Bar", type: "Outlet", floor: "3", cc: "CC-31", list: "A",
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

  it("stops on a full-page failure when the credentials are good and the snapshot is not", async () => {
    // The registries start empty and only a snapshot fills them, so "showing what is in memory"
    // would put `LOC[loc].n` on screen against `{}` and land the whole app in the error
    // boundary. `auth: "failed"` is the state that says so, and `restore()` must not throw.
    fetchMock
      .mockResolvedValueOnce(ok({ accessToken: "new", user: USER, mustChangePassword: false }))
      .mockResolvedValueOnce(ok({ error: { code: "internal", message: "Something went wrong." } }, 500));
    await expect(useApp.getState().restore()).resolves.toBeUndefined();
    expect(useApp.getState().auth).toBe("failed");
    expect(useApp.getState().user?.id).toBe("u1");

    // The failed page's other way out is Sign out, not just Retry - an operator stuck on a
    // broken snapshot (or signed in as the wrong person) must be able to reach the sign-in
    // form again. It is the same `logout()` the shell itself calls, so it lands on
    // `auth: "signed-out"` with no user, the two things `App.tsx` reads to render Login.
    fetchMock.mockResolvedValueOnce(ok({}));
    await useApp.getState().logout();
    expect(useApp.getState().auth).toBe("signed-out");
    expect(useApp.getState().user).toBeNull();

    // Back on a failed snapshot, the Retry the shell offers is `loadSnapshot` again -
    // nothing else has to be re-done.
    useApp.setState({ user: USER, auth: "failed" });
    fetchMock.mockResolvedValueOnce(ok(SNAPSHOT));
    await useApp.getState().loadSnapshot();
    expect(useApp.getState().auth).toBe("ready");
  });

  it("leaves a session that is already signed in alone", async () => {
    setAccessToken("tok");
    useApp.setState({ user: USER, auth: "ready" });
    await useApp.getState().restore();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useApp.getState().auth).toBe("ready");
  });
});

describe("changing the password", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    setAccessToken("must-change");
    useApp.setState({ user: USER, auth: "ready", mustChangePassword: true, toast: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("swaps in the session the change hands back, then loads the snapshot", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ accessToken: "after-change", user: USER, mustChangePassword: false }))
      .mockResolvedValueOnce(ok(SNAPSHOT));
    expect(await useApp.getState().changePassword("changeme", "a-much-longer-secret")).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/change-password");
    // The old token still says "must change password"; keeping it would 403 the snapshot.
    expect(getAccessToken()).toBe("after-change");
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer after-change");
    expect(useApp.getState().mustChangePassword).toBe(false);
    expect(useApp.getState().auth).toBe("ready");
  });

  /**
   * Which of the two screens the change is made from decides whether the splash is right, and
   * `loadSnapshot` already asks that question - "is the master empty?" - for every other caller.
   * `changePassword` used to answer it for itself with a flat `auth: "loading"`, which is right
   * on a first sign-in and wrong from Settings, where it threw the operator's whole screen away
   * and painted "Loading…" over a working hospital for the length of a snapshot.
   */
  it("does not blank a hospital that is already on screen", async () => {
    hydrateMaster({ ...EMPTY_MASTER, locations: { coffee: COFFEE } });
    const seen: string[] = [];
    const stop = useApp.subscribe((s) => { seen.push(s.auth); });
    fetchMock
      .mockResolvedValueOnce(ok({ accessToken: "after-change", user: USER, mustChangePassword: false }))
      .mockResolvedValueOnce(ok({ ...SNAPSHOT, locations: { coffee: COFFEE } }));

    expect(await useApp.getState().changePassword("changeme", "a-much-longer-secret")).toBe(true);
    stop();

    expect(seen).not.toContain("loading");
    expect(useApp.getState().auth).toBe("ready");
  });

  it("still paints the splash on a first sign-in, where there is no screen to keep", async () => {
    hydrateMaster(EMPTY_MASTER);
    const seen: string[] = [];
    const stop = useApp.subscribe((s) => { seen.push(s.auth); });
    fetchMock
      .mockResolvedValueOnce(ok({ accessToken: "after-change", user: USER, mustChangePassword: false }))
      .mockResolvedValueOnce(ok(SNAPSHOT));

    await useApp.getState().changePassword("changeme", "a-much-longer-secret");
    stop();

    expect(seen).toContain("loading");
  });
});
