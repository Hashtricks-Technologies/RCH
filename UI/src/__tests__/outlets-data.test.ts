import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as FX from "@rch/contract/fixtures";
import { LOC } from "../data/master";
import { allOutlets, locName, openOutlets, operationalLocs, parOf } from "../lib/selectors";
import { refetch } from "../api/refetch";
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import { as, resetStore } from "./fixture";

/**
 * Outlets read live off the location master - `LOC`, filled by `hydrateLocations` - never off a
 * list of five names compiled into the bundle. An outlet the super admin opens at runtime has to
 * show up in every picker the moment its write lands, with nothing else in the bundle changed.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn();
type Stubs = Record<string, () => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make ? make() : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const hit = (at: string) =>
  fetchMock.mock.calls.filter(([u, init]) => `${(init as RequestInit).method} ${String(u).split("?")[0]}` === at);

beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); });

describe("outlets, read from the master", () => {
  it("lists the open outlets by name, and every outlet for a filter over history", () => {
    expect(openOutlets()).toEqual(["coffee", "rest", "kiosk"]);
    LOC.kiosk = { ...LOC.kiosk, active: false };
    expect(openOutlets()).toEqual(["coffee", "rest"]);
    expect(allOutlets()).toEqual(["coffee", "rest", "kiosk"]);
    expect(locName("kiosk")).toBe("Snack Kiosk (closed)");
    expect(locName("rest")).toBe("Restaurant");
    expect(locName("juice-bar")).toBe("juice-bar");
    expect(operationalLocs()).toEqual(["store", "kitchen", "coffee", "rest"]);
  });
  it("sizes a par level from the factor the location carries", () => {
    const it0 = Object.keys(FX.IT).find((k) => FX.IT[k].rl > 0 && FX.IT[k].u !== "nos")!;
    expect(parOf("rest", it0)).toBeCloseTo(FX.IT[it0].rl * 0.22, 3);
  });
});

describe("a change to the locations", () => {
  const JUICE = { n: "Juice Bar", c: "OT-JB", type: "Outlet", floor: "Ground", cc: "CC-JB", list: "A", active: true, par: 0.18 };
  it("pulls the location master back for an operational session and puts the new outlet in every picker", async () => {
    as("manager");
    serve({ "GET /api/v1/locations": () => json({ ...FX.LOC, "juice-bar": JUICE }) });
    const before = useApp.getState().catalogVersion;
    await refetch(["locations"]);
    expect(openOutlets()).toContain("juice-bar");
    expect(useApp.getState().stock["juice-bar"]).toEqual({});
    expect(useApp.getState().catalogVersion).toBe(before + 1);
  });
  it("reads nothing for the super admin, whose token reaches no location read but its own", async () => {
    useApp.setState({ user: { ...FX.USERS.find((u) => u.admin)! } });
    serve({});
    await refetch(["locations"]);
    expect(hit("GET /api/v1/locations")).toHaveLength(0);
  });
});
