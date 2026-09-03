import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { avail, availOf, priceOf, qty, resv } from "../lib/selectors";
import { resetStore, S, as } from "./fixture";

beforeEach(resetStore);

describe("counter operator", () => {
  it("raises a multi-item request", () => {
    as("counter");
    S().setDraft([{ it: "milk", qty: 20 }, { it: "sugar", qty: 4 }]);
    const before = S().req.length;
    S().submitRequest("Counter runs dry by 4pm", true);
    expect(S().req).toHaveLength(before + 1);
    const r = S().req[S().req.length - 1];
    expect(r.lines).toHaveLength(2);
    expect(r.st).toBe("Request sent");
    expect(r.from).toBe("coffee");
    expect(S().draft).toHaveLength(0);
  });

  it("cancels only while the request is still open", () => {
    as("counter");
    S().cancelRequest("REQ-2026-0911");
    expect(S().req.find((r) => r.id === "REQ-2026-0911")!.st).toBe("Cancelled");
    S().cancelRequest("REQ-2026-0909");
    expect(S().req.find((r) => r.id === "REQ-2026-0909")!.st).toBe("Ticket issued");
  });

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

describe("the two-stage approval chain", () => {
  it("manager trims the quantity, store issues a ticket for only what was approved", () => {
    as("manager");
    S().approveRequest("REQ-2026-0911", [12], "Store only holds 12 L.");
    const r = () => S().req.find((x) => x.id === "REQ-2026-0911")!;
    expect(r().lines[0].appr).toBe(12);
    expect(r().st).toBe("Partially approved");
    expect(r().mgrNote).toBe("Store only holds 12 L.");
    expect(r().ticket).toBeNull();

    as("store");
    const stockBefore = qty(S(), "store", "milk");
    S().issueTicket("REQ-2026-0911");
    const t = S().tkt[S().tkt.length - 1];
    expect(t.lines[0].qty).toBe(12);
    expect(r().st).toBe("Ticket issued");
    expect(qty(S(), "store", "milk")).toBe(stockBefore);
    expect(avail(S(), "store", "milk")).toBe(stockBefore - 12);

    S().handover(t.id);
    expect(qty(S(), "store", "milk")).toBe(stockBefore - 12);
    expect(avail(S(), "store", "milk")).toBe(stockBefore - 12);
    expect(S().tkt.find((x) => x.id === t.id)!.st).toBe("Collected");

    as("counter");
    const coffeeBefore = qty(S(), "coffee", "milk");
    S().receiveTicket(t.id);
    expect(qty(S(), "coffee", "milk")).toBe(coffeeBefore + 12);
    expect(r().st).toBe("Closed");
    expect(availOf(S(), "coffee", "capp").ok).toBe(true);
  });

  it("a manager cannot approve more than was asked, nor more than the store can cover", () => {
    as("manager");
    S().approveRequest("REQ-2026-0911", [999], "");
    const line = S().req.find((x) => x.id === "REQ-2026-0911")!.lines[0];
    expect(line.appr).toBeLessThanOrEqual(line.qty);
    expect(line.appr).toBe(qty(S(), "store", "milk"));
  });

  it("rejecting issues no ticket", () => {
    as("manager");
    S().approveRequest("REQ-2026-0912", [0, 0, 0], "Nothing to spare");
    const r = S().req.find((x) => x.id === "REQ-2026-0912")!;
    expect(r.st).toBe("Rejected");
    as("store");
    const before = S().tkt.length;
    S().issueTicket("REQ-2026-0912");
    expect(S().tkt).toHaveLength(before);
  });
});

describe("production", () => {
  it("accepts, makes and dispatches, creating a ticket", () => {
    as("prod");
    S().setOrderStatus("PRD-2026-029", "Accepted");
    expect(S().pord.find((o) => o.id === "PRD-2026-029")!.st).toBe("Accepted");
    const kitchenBefore = qty(S(), "kitchen", "puff");
    S().makeProduct("puff", 60);
    expect(qty(S(), "kitchen", "puff")).toBe(kitchenBefore + 60);
    expect(S().batch[0].qty).toBe(60);
    const tktBefore = S().tkt.length;
    S().dispatchOrder("PRD-2026-029");
    expect(S().tkt).toHaveLength(tktBefore + 1);
    // The ticket reserves; the scan at the window is what moves the stock.
    expect(qty(S(), "kitchen", "puff")).toBe(kitchenBefore + 60);
    expect(resv(S(), "kitchen", "puff")).toBe(40);
    S().handover(S().tkt[S().tkt.length - 1].id);
    expect(qty(S(), "kitchen", "puff")).toBe(kitchenBefore + 60 - 40);
    expect(S().pord.find((o) => o.id === "PRD-2026-029")!.st).toBe("Dispatched");
  });
  it("refuses to distribute more than the kitchen holds", () => {
    as("prod");
    const before = S().tkt.length;
    S().distribute("salad", 9999, "kiosk");
    expect(S().tkt).toHaveLength(before);
  });
});
