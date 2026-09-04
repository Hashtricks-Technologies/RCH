import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import {
  availOf, canCancelTicket, canDispatch, canHandOver, canIssueTicket, canMoveOrder,
  canReceiveTicket, hasLeft, isReqOpen, isTicketOpen, priceOf,
} from "../lib/selectors";
import { REPORTS } from "../roles/store/Reports";
import type { TktStatus } from "../types";
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
  it("walks the board one stage at a time, and never skips one", () => {
    expect(canMoveOrder("New", "Accepted")).toBe(true);
    expect(canMoveOrder("New", "Declined")).toBe(true);
    expect(canMoveOrder("Accepted", "In kitchen")).toBe(true);
    expect(canMoveOrder("In kitchen", "Ready")).toBe(true);
    expect(canMoveOrder("New", "Ready")).toBe(false);
    expect(canMoveOrder("Ready", "Accepted")).toBe(false);
    expect(canMoveOrder("Declined", "Accepted")).toBe(false);
  });
  it("draws no status button for a dispatched order — the way back is cancelling its ticket", () => {
    // The one line the table cannot express: PROD_ORDER_TRANSITIONS has Dispatched -> Ready so
    // a cancellation can put the order back, and `setStatus` refuses that source itself.
    expect(canMoveOrder("Dispatched", "Ready")).toBe(false);
    expect(canMoveOrder("Dispatched", "Accepted")).toBe(false);
    expect(canMoveOrder("Dispatched", "Declined")).toBe(false);
  });
  it("never offers Dispatched as a word — a dispatch is a movement with its own endpoint", () => {
    for (const st of ["New", "Accepted", "In kitchen", "Ready"] as const) {
      expect(canMoveOrder(st, "Dispatched")).toBe(false);
      // …and the control that does exist for those stages is the dispatch button's own.
      expect(canDispatch(st)).toBe(true);
    }
  });
  it("withdraws only a ticket nobody has collected against", () => {
    expect(canCancelTicket("Issued")).toBe(true);
    expect(canCancelTicket("Collected")).toBe(false);
    expect(canCancelTicket("Received")).toBe(false);
    expect(canCancelTicket("Cancelled")).toBe(false);
  });
  it("counts a ticket as still moving only while it is at the window or in transit", () => {
    expect(isTicketOpen("Issued")).toBe(true);
    expect(isTicketOpen("Collected")).toBe(true);
    expect(isTicketOpen("Received")).toBe(false);
    // The reason this predicate exists: `!== "Received"` called a withdrawn ticket moving.
    expect(isTicketOpen("Cancelled")).toBe(false);
  });
  it("counts stock as gone from the window only once it has actually left", () => {
    // A ticket still at the window has moved nothing, and a withdrawn one never will.
    expect(hasLeft("Issued")).toBe(false);
    expect(hasLeft("Cancelled")).toBe(false);
    expect(hasLeft("Collected")).toBe(true);
    expect(hasLeft("Received")).toBe(true);
  });
});

/**
 * The store's reports are pure `AppState -> Rep` builds, so what a report counts can be driven
 * straight rather than read out of rendered HTML. TKT-0440 — 500 paper cups, store to the
 * Coffee Shop — is the only seeded ticket the store raised, which makes it the whole of both
 * of these numbers.
 */
describe("the store's reports read a withdrawn ticket as withdrawn", () => {
  const report = (k: string) => REPORTS.find((r) => r.k === k)!.build(S());
  const cell = (k: string, row: string, col: string) => {
    const rep = report(k);
    return rep.rows.find((r) => r[0] === row)![rep.cols.findIndex((c) => c.h === col)];
  };
  const setTicketStatus = (st: TktStatus) =>
    useApp.setState({ tkt: S().tkt.map((t) => (t.id === "TKT-0440" ? { ...t, st } : t)) });

  it("leaves Issued out and Opening exactly where they were when the ticket is cancelled (I3)", () => {
    // The store holds 2400 cups and has received none today, so closing is opening less
    // whatever went out — and nothing has gone out while the ticket is still at the window.
    expect(cell("ledger", "Paper cup 150ml", "Issued out")).toBe("0");
    expect(cell("ledger", "Paper cup 150ml", "Opening")).toBe("2400");

    setTicketStatus("Collected");                       // the collector came: the stock left
    expect(cell("ledger", "Paper cup 150ml", "Issued out")).toBe("500");
    expect(cell("ledger", "Paper cup 150ml", "Opening")).toBe("2900");

    setTicketStatus("Cancelled");                       // withdrawn: it never left after all
    expect(cell("ledger", "Paper cup 150ml", "Issued out")).toBe("0");
    expect(cell("ledger", "Paper cup 150ml", "Opening")).toBe("2400");
  });

  it("drops a withdrawn ticket out of the issue register so the row adds up (I4)", () => {
    // At the window: one ticket, one line, 500 cups, and the "At the window" column agrees.
    expect(cell("issreg", "Coffee Shop", "Tickets")).toBe("1");
    expect(cell("issreg", "Coffee Shop", "Quantity")).toBe("500 nos");
    expect(cell("issreg", "Coffee Shop", "At the window")).toBe("1");

    setTicketStatus("Cancelled");
    // The three status columns can no longer account for it, so neither may the totals — the
    // Coffee Shop drops off the register altogether, because that ticket was all it had.
    expect(report("issreg").rows.find((r) => r[0] === "Coffee Shop")).toBeUndefined();
    expect(report("issreg").foot).toBe("0 tickets standing against Central Store — withdrawn tickets are left out");
  });
});

describe("production", () => {
  // The whole of the kitchen is the server's from Phase 4: production.test.ts covers the
  // board ("walks the board a stage at a time and signs each step") and the batch ("consumes
  // the recipe for what was started and books only what came good"); the two store calls that
  // reach those routes are in writes.test.ts. Dispatch and handover moved in Phase 3.
  it.todo("nothing left in memory — see apps/api/src/modules/production/production.test.ts");
});
