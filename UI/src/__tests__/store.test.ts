import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import {
  availOf, canDispatch, canHandOver, canIssueTicket, canReceiveTicket, isReqOpen, priceOf,
} from "../lib/selectors";
import { resetStore, S, as } from "./fixture";

beforeEach(resetStore);

describe("counter operator", () => {
  it("builds one cart line per item scanned", () => {
    as("counter");
    S().addToCart("coffee", "capp");
    S().addToCart("coffee", "capp");
    S().addToCart("coffee", "juice");
    expect(S().cart.coffee).toEqual({ capp: 2, juice: 1 });
    S().clearCart("coffee");
    expect(S().cart.coffee).toEqual({});
  });

  it("holds the printed MRP as a ceiling on floor 3", () => {
    // Seeded lists now sit at or under MRP, so push a breaching price straight
    // into state — the till must still refuse to charge above the printed MRP.
    useApp.setState({ prices: { ...S().prices, B: { ...S().prices.B, juice: 25 } } });
    const p = priceOf(S(), "coffee", "juice");
    expect(p.p).toBe(20);
    expect(p.capped).toBe(true);
  });
});

describe("availability", () => {
  it("switches a drink off when an ingredient hits zero and names it", () => {
    const a = availOf(S(), "coffee", "capp");
    expect(a.ok).toBe(false);
    expect(a.mode).toBe("Recipe");
    expect(a.why).toContain("Milk");
  });
  it("manual override wins over a stocked shelf and reverses", () => {
    // juice is stocked at the kiosk, so only the manual switch can take it off sale.
    // `ovr` is the server's map, applied by applyStock — the screens read it through availOf.
    expect(availOf(S(), "kiosk", "juice").ok).toBe(true);
    useApp.setState({ ovr: { "kiosk:juice": "switched off manually" } });
    expect(availOf(S(), "kiosk", "juice").ok).toBe(false);
    expect(availOf(S(), "kiosk", "juice").mode).toBe("Manual");
    useApp.setState({ ovr: {} });
    expect(availOf(S(), "kiosk", "juice").ok).toBe(true);
  });
});

/**
 * The request and ticket chain itself is the server's (requests.test.ts, tickets.test.ts);
 * what is left on this side is which controls a screen may offer, and those read the same
 * transition table the server enforces.
 */
describe("what a button may offer is what the server accepts", () => {
  it("cancels only while the request is still open", () => {
    expect(isReqOpen("Request sent")).toBe(true);
    expect(isReqOpen("Draft")).toBe(true);
    expect(isReqOpen("Ticket issued")).toBe(false);
    expect(isReqOpen("Closed")).toBe(false);
  });
  it("offers a ticket only for a decision that has one to give", () => {
    expect(canIssueTicket("Manager approved")).toBe(true);
    expect(canIssueTicket("Partially approved")).toBe(true);
    expect(canIssueTicket("Request sent")).toBe(false);
    expect(canIssueTicket("Rejected")).toBe(false);
  });
  it("offers handover and receipt in order", () => {
    expect(canHandOver("Issued")).toBe(true);
    expect(canHandOver("Collected")).toBe(false);
    expect(canReceiveTicket("Collected")).toBe(true);
    expect(canReceiveTicket("Issued")).toBe(false);
  });
  it("offers dispatch on any open order, never on one already gone or turned down", () => {
    expect(canDispatch("Ready")).toBe(true);
    expect(canDispatch("Accepted")).toBe(true);
    expect(canDispatch("Dispatched")).toBe(false);
    expect(canDispatch("Declined")).toBe(false);
  });
});

describe("production", () => {
  // The whole of the kitchen is the server's from Phase 4: production.test.ts covers the
  // board ("walks the board a stage at a time and signs each step") and the batch ("consumes
  // the recipe for what was started and books only what came good"); the two store calls that
  // reach those routes are in writes.test.ts. Dispatch and handover moved in Phase 3.
  it.todo("nothing left in memory — see apps/api/src/modules/production/production.test.ts");
});
