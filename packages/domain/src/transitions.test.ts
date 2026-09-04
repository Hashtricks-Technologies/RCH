import { describe, expect, it } from "vitest";
import { PROD_ORDER_TRANSITIONS, REQUEST_TRANSITIONS, SHOP_ASK_TRANSITIONS, TICKET_TRANSITIONS, canTransition } from "./transitions";

describe("request transitions", () => {
  it("walks the chain the outlet actually walks", () => {
    expect(canTransition(REQUEST_TRANSITIONS, "Request sent", "Manager approved")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Request sent", "Partially approved")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Manager approved", "Ticket issued")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Ticket issued", "Collected")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Collected", "Closed")).toBe(true);
  });
  it("refuses a second decision on a request already decided", () => {
    expect(canTransition(REQUEST_TRANSITIONS, "Manager approved", "Partially approved")).toBe(false);
    expect(canTransition(REQUEST_TRANSITIONS, "Rejected", "Manager approved")).toBe(false);
    expect(canTransition(REQUEST_TRANSITIONS, "Ticket issued", "Cancelled")).toBe(false);
  });
  it("cancels only while the request is still open", () => {
    expect(canTransition(REQUEST_TRANSITIONS, "Draft", "Cancelled")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Request sent", "Cancelled")).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, "Manager approved", "Cancelled")).toBe(false);
    expect(canTransition(REQUEST_TRANSITIONS, "Closed", "Cancelled")).toBe(false);
  });
  it("leaves Closed, Rejected and Cancelled terminal", () => {
    for (const st of ["Closed", "Rejected", "Cancelled"] as const) expect(REQUEST_TRANSITIONS[st]).toEqual([]);
  });
});

describe("ticket transitions", () => {
  it("is issued, collected, received — in that order and no other", () => {
    expect(canTransition(TICKET_TRANSITIONS, "Issued", "Collected")).toBe(true);
    expect(canTransition(TICKET_TRANSITIONS, "Collected", "Received")).toBe(true);
    expect(canTransition(TICKET_TRANSITIONS, "Issued", "Received")).toBe(false);
    expect(canTransition(TICKET_TRANSITIONS, "Collected", "Issued")).toBe(false);
    expect(TICKET_TRANSITIONS.Received).toEqual([]);
  });
});

describe("shop ask transitions", () => {
  it("is answered once", () => {
    expect(canTransition(SHOP_ASK_TRANSITIONS, "Asked", "Sent")).toBe(true);
    expect(canTransition(SHOP_ASK_TRANSITIONS, "Asked", "Declined")).toBe(true);
    expect(canTransition(SHOP_ASK_TRANSITIONS, "Sent", "Declined")).toBe(false);
    expect(canTransition(SHOP_ASK_TRANSITIONS, "Declined", "Sent")).toBe(false);
  });
});

describe("production order transitions", () => {
  it("may go out from any open stage, because a kitchen sends when it is ready", () => {
    for (const st of ["New", "Accepted", "In kitchen", "Ready"] as const) {
      expect(canTransition(PROD_ORDER_TRANSITIONS, st, "Dispatched")).toBe(true);
    }
  });
  it("walks the board in order otherwise", () => {
    expect(canTransition(PROD_ORDER_TRANSITIONS, "New", "Accepted")).toBe(true);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "New", "Declined")).toBe(true);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "Accepted", "In kitchen")).toBe(true);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "In kitchen", "Ready")).toBe(true);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "New", "Ready")).toBe(false);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "Ready", "Accepted")).toBe(false);
  });
  it("is finished once it has gone out or been turned down", () => {
    expect(PROD_ORDER_TRANSITIONS.Dispatched).toEqual([]);
    expect(PROD_ORDER_TRANSITIONS.Declined).toEqual([]);
  });
});
