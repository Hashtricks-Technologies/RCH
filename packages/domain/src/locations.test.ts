import { describe, expect, it } from "vitest";
import * as FX from "@rch/contract/fixtures";
import type { Location } from "@rch/contract";
import { atOutlet, closeRefusal, holding, HOLDS_OUTLET, operationalKeys, outletKeyFor, outletKeys, placesFor, worksAt } from "./locations";

const juice: Location = { n: "Juice Bar", c: "OT-JB", type: "Outlet", floor: "G", cc: "CC-JB", list: "A", active: true, par: 0.18 };
const closed = (l: Location): Location => ({ ...l, active: false });

describe("outletKeys", () => {
  it("lists the Outlet-type locations by name, never the store, the kitchen or quarantine", () => {
    expect(outletKeys(FX.LOC)).toEqual(["coffee", "rest", "kiosk"]);    // Coffee Shop, Restaurant, Snack Kiosk
  });
  it("leaves a closed outlet out only when asked for the open ones", () => {
    const locs = { ...FX.LOC, kiosk: closed(FX.LOC.kiosk), "juice-bar": juice };
    expect(outletKeys(locs)).toEqual(["coffee", "juice-bar", "rest", "kiosk"]);
    expect(outletKeys(locs, { open: true })).toEqual(["coffee", "juice-bar", "rest"]);
  });
  it("orders two outlets with one printed name by key, so the order never depends on insertion", () => {
    expect(outletKeys({ b: { ...juice }, a: { ...juice } })).toEqual(["a", "b"]);
  });
  it("reads an outlet with no `active` as open", () => {
    // Another test double: the wire never actually omits `active`, but `open()`'s fallback is
    // insurance kept for whatever passes a location-shaped object without it.
    const { active: _, ...bare } = juice;
    expect(outletKeys({ x: bare as Location }, { open: true })).toEqual(["x"]);
  });
});

describe("operationalKeys", () => {
  it("is the store, the kitchen, then the open outlets - never quarantine", () => {
    expect(operationalKeys({ ...FX.LOC, kiosk: closed(FX.LOC.kiosk) })).toEqual(["store", "kitchen", "coffee", "rest"]);
  });
  it("leaves out a singleton the master has not sent yet", () => {
    expect(operationalKeys({})).toEqual([]);
  });
});

describe("worksAt / placesFor", () => {
  const locs = { ...FX.LOC, kiosk: closed(FX.LOC.kiosk) };
  it.each([
    ["prod", "kitchen", true], ["prod", "store", false],
    ["store", "store", true], ["buyer", "store", true], ["buyer", "rest", false],
    ["counter", "rest", true], ["manager", "coffee", true], ["counter", "store", false],
    ["counter", "kiosk", false], ["manager", "kiosk", false], ["counter", "nowhere", false],
  ] as const)("%s at %s is %s", (role, key, ok) => {
    expect(worksAt(role, key, locs[key as keyof typeof locs])).toBe(ok);
  });
  it("offers each role exactly the places it may work", () => {
    expect(placesFor("prod", locs)).toEqual(["kitchen"]);
    expect(placesFor("store", locs)).toEqual(["store"]);
    expect(placesFor("buyer", locs)).toEqual(["store"]);
    expect(placesFor("counter", locs)).toEqual(["coffee", "rest"]);
    expect(placesFor("manager", locs)).toEqual(["coffee", "rest"]);
  });
  it("seats the counter and the manager at an outlet, and nobody else", () => {
    expect((["counter", "manager", "store", "prod", "buyer"] as const).filter(atOutlet)).toEqual(["counter", "manager"]);
  });
});

describe("outletKeyFor", () => {
  it("makes a lower-case, dash-joined key from the name", () => {
    expect(outletKeyFor("Juice Bar", [])).toBe("juice-bar");
    expect(outletKeyFor("  Dr. Rao's  Café & Tea!! ", [])).toBe("dr-rao-s-caf-tea");
  });
  it("steps past a key already taken, and past the three the code reserves", () => {
    expect(outletKeyFor("Juice Bar", ["juice-bar", "juice-bar-2"])).toBe("juice-bar-3");
    expect(outletKeyFor("Store", [])).toBe("store-2");
    expect(outletKeyFor("Kitchen", [])).toBe("kitchen-2");
    expect(outletKeyFor("Quarantine", [])).toBe("quarantine-2");
  });
  it("starts with a letter and stays inside the 24 characters a key may have", () => {
    expect(outletKeyFor("7 Eleven", [])).toBe("outlet-7-eleven");
    expect(outletKeyFor("!!!", [])).toBe("outlet");
    const long = outletKeyFor("The Very Long Name Of A Hospital Outlet", []);
    expect(long.length).toBeLessThanOrEqual(20);
    expect(long).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    expect(outletKeyFor("The Very Long Name Of A Hospital Outlet", [long]).length).toBeLessThanOrEqual(24);
  });
});

describe("HOLDS_OUTLET", () => {
  it("counts a document as holding an outlet until it is settled", () => {
    expect(holding(HOLDS_OUTLET.ticket)).toEqual(["Issued", "Collected"]);
    expect(holding(HOLDS_OUTLET.request)).toEqual(["Draft", "Request sent", "Manager approved", "Partially approved", "Ticket issued", "Collected", "Received"]);
    // A dispatched order and a sent ask each keep an undo edge in their transition tables, but the
    // ticket they raised is what holds the outlet now - so neither is open here.
    expect(holding(HOLDS_OUTLET.prodOrder)).toEqual(["New", "Accepted", "In kitchen", "Ready"]);
    expect(holding(HOLDS_OUTLET.shopAsk)).toEqual(["Asked"]);
    expect(holding(HOLDS_OUTLET.productReq)).toEqual(["Requested"]);
    expect(holding(HOLDS_OUTLET.qrOrder)).toEqual(["Paid", "Preparing", "Ready", "Out for delivery"]);
  });
});

describe("closeRefusal", () => {
  const none = { stock: 0, tickets: 0, requests: 0, kitchenOrders: 0, shopAsks: 0, productRequests: 0, staff: [], openRegister: false };
  it("has nothing to say about an outlet nothing depends on", () => {
    expect(closeRefusal("Juice Bar", none)).toBeNull();
  });
  it("names the one thing left", () => {
    expect(closeRefusal("Juice Bar", { ...none, tickets: 2 })).toBe("Refused - Juice Bar still has 2 open tickets");
    expect(closeRefusal("Juice Bar", { ...none, stock: 1 })).toBe("Refused - Juice Bar still has stock on hand (1 item)");
    // A day nobody has closed off. Shutting the outlet first would strand the takings: the Z is
    // still allowed at a closed outlet, but the honest order is to take it before closing.
    expect(closeRefusal("Juice Bar", { ...none, openRegister: true }))
      .toBe("Refused - Juice Bar still has an open register (take its Z-report first)");
  });
  it("names every blocker at once, singular for one, the last joined with and", () => {
    expect(closeRefusal("Juice Bar", { stock: 3, tickets: 1, requests: 1, kitchenOrders: 2, shopAsks: 1, productRequests: 1, staff: ["RC-4483", "RC-4484"], openRegister: true }))
      .toBe("Refused - Juice Bar still has stock on hand (3 items), 1 open ticket, 1 open stock request, 2 open kitchen orders, 1 open shop ask, 1 open product request, 2 active staff (RC-4483, RC-4484) and an open register (take its Z-report first)");
  });
});
