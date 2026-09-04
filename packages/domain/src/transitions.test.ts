import { describe, expect, it } from "vitest";
import { PO_TRANSITIONS, PROD_ORDER_TRANSITIONS, REQUEST_TRANSITIONS, REQUISITION_TRANSITIONS, SHOP_ASK_TRANSITIONS, TICKET_TRANSITIONS, canTransition } from "./transitions";

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

  it("lets a withdrawn grant put the ask back on the shop's desk", () => {
    // Phase 6 gives the counter a cancel door. Withdrawing the ticket a grant raised has to leave
    // the ask somewhere the holding shop can answer it again — Sent with a cancelled ticket behind
    // it would be a lie on both screens.
    expect(canTransition(SHOP_ASK_TRANSITIONS, "Sent", "Asked")).toBe(true);
    expect(canTransition(SHOP_ASK_TRANSITIONS, "Declined", "Asked")).toBe(false);
    expect(canTransition(SHOP_ASK_TRANSITIONS, "Sent", "Declined")).toBe(false);
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
  it("is finished once it has been turned down", () => {
    expect(PROD_ORDER_TRANSITIONS.Declined).toEqual([]);
  });
  it("comes back from Dispatched only for a cancelled ticket", () => {
    expect(PROD_ORDER_TRANSITIONS.Dispatched).toEqual(["Ready"]);
  });
});

describe("a ticket that was never collected", () => {
  it("may be taken back while it is still at the window", () => {
    expect(canTransition(TICKET_TRANSITIONS, "Issued", "Cancelled")).toBe(true);
  });
  it("may not be taken back once the stock is in transit or on the shelf", () => {
    expect(canTransition(TICKET_TRANSITIONS, "Collected", "Cancelled")).toBe(false);
    expect(canTransition(TICKET_TRANSITIONS, "Received", "Cancelled")).toBe(false);
  });
  it("is finished once it is cancelled", () => {
    expect(TICKET_TRANSITIONS.Cancelled).toEqual([]);
  });
  it("puts the production order behind it back on the board, and nowhere else", () => {
    expect(canTransition(PROD_ORDER_TRANSITIONS, "Dispatched", "Ready")).toBe(true);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "Dispatched", "Accepted")).toBe(false);
    expect(canTransition(PROD_ORDER_TRANSITIONS, "Dispatched", "Dispatched")).toBe(false);
  });
  it("leaves the request table alone — a request comes back through the cancel endpoint's own guard", () => {
    expect(canTransition(REQUEST_TRANSITIONS, "Ticket issued", "Manager approved")).toBe(false);
    expect(canTransition(REQUEST_TRANSITIONS, "Ticket issued", "Collected")).toBe(true);
    expect(REQUEST_TRANSITIONS["Ticket issued"]).toEqual(["Collected"]);
  });
});

describe("a requisition is decided once", () => {
  it("goes from Sent to any of the three decisions", () => {
    expect(canTransition(REQUISITION_TRANSITIONS, "Sent", "Approved")).toBe(true);
    expect(canTransition(REQUISITION_TRANSITIONS, "Sent", "Partially approved")).toBe(true);
    expect(canTransition(REQUISITION_TRANSITIONS, "Sent", "Declined")).toBe(true);
  });
  it("is finished the moment it is decided — what happens next happens on the orders", () => {
    for (const st of ["Approved", "Partially approved", "Declined"] as const) {
      expect(REQUISITION_TRANSITIONS[st]).toEqual([]);
    }
  });
});

describe("a purchase order's life", () => {
  it("goes out or is dropped while it is a draft", () => {
    expect(PO_TRANSITIONS.Draft).toEqual(["Ordered", "Cancelled"]);
  });
  it("takes goods once it is ordered, in one delivery or several", () => {
    expect(canTransition(PO_TRANSITIONS, "Ordered", "Received")).toBe(true);
    expect(canTransition(PO_TRANSITIONS, "Ordered", "Partially received")).toBe(true);
  });
  it("re-enters Partially received on a second instalment that still does not finish it", () => {
    expect(canTransition(PO_TRANSITIONS, "Partially received", "Partially received")).toBe(true);
  });
  it("cannot be cancelled once anything has arrived", () => {
    expect(canTransition(PO_TRANSITIONS, "Partially received", "Cancelled")).toBe(false);
    expect(canTransition(PO_TRANSITIONS, "Received", "Cancelled")).toBe(false);
  });
  it("is finished when it is received or cancelled", () => {
    expect(PO_TRANSITIONS.Received).toEqual([]);
    expect(PO_TRANSITIONS.Cancelled).toEqual([]);
  });
  it("never goes back to a draft", () => {
    for (const st of ["Ordered", "Partially received", "Received", "Cancelled"] as const) {
      expect(canTransition(PO_TRANSITIONS, st, "Draft")).toBe(false);
    }
  });
});
