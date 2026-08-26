import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { avail, availOf, priceOf, qty } from "../lib/selectors";
import { seedBills, seedBatch, seedPo, seedPord, seedPrq, seedReq, seedStock, seedTkt } from "../data/seed";
import { basePrices } from "../lib/selectors";
import { MENU, USERS } from "../data/master";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const S = () => useApp.getState();
const as = (role: string) => useApp.getState().signIn(USERS.find((u) => u.r === role)!.id);

beforeEach(() => {
  useApp.setState({
    user: null, stock: clone(seedStock), rsv: {}, ovr: {}, prices: basePrices(), menu: clone(MENU),
    req: clone(seedReq), tkt: clone(seedTkt), prq: clone(seedPrq), po: clone(seedPo),
    pord: clone(seedPord), batch: clone(seedBatch), bills: clone(seedBills),
    seq: { req: 912, tkt: 440, bill: 1187, prq: 13, po: 142, pord: 30, bat: 1 },
    cart: {}, draft: [], prqDraft: [], drawer: null, toast: null, shopFilter: null,
  });
});

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

  it("deducts a made-to-order drink by recipe, not by the unit", () => {
    as("counter");
    useApp.setState((s) => ({ stock: { ...s.stock, coffee: { ...s.stock.coffee, milk: 5 } } }));
    S().addToCart("coffee", "capp");
    S().addToCart("coffee", "capp");
    S().pay("coffee", "Cash");
    expect(qty(S(), "coffee", "milk")).toBeCloseTo(4.7, 3);
    expect(S().bills[0].tot).toBe(150);
    expect(S().bills[0].opr).toBe("Kavitha Raman");
  });

  it("holds the printed MRP as a ceiling on floor 3", () => {
    expect(S().prices.B.juice).toBe(25);
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
  it("manual override wins and reverses", () => {
    S().toggleAvail("rest", "capp");
    expect(availOf(S(), "rest", "capp").ok).toBe(false);
    expect(availOf(S(), "rest", "capp").mode).toBe("Manual");
    S().toggleAvail("rest", "capp");
    expect(availOf(S(), "rest", "capp").ok).toBe(true);
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

  it("a manager cannot approve more than was asked", () => {
    as("manager");
    S().approveRequest("REQ-2026-0911", [999], "");
    expect(S().req.find((x) => x.id === "REQ-2026-0911")!.lines[0].appr).toBe(20);
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

describe("pricing", () => {
  it("refuses a price above the printed MRP", () => {
    as("manager");
    S().savePrice("B", "juice", 99);
    expect(S().prices.B.juice).toBe(25);
  });
  it("accepts a price at or below MRP", () => {
    as("manager");
    S().savePrice("B", "juice", 18);
    expect(S().prices.B.juice).toBe(18);
    expect(priceOf(S(), "coffee", "juice").p).toBe(18);
  });
  it("removes a product from one shop only", () => {
    as("manager");
    S().removeProduct("coffee", "chips");
    expect(S().menu.coffee).not.toContain("chips");
    expect(S().menu.kiosk).toContain("chips");
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
    expect(qty(S(), "kitchen", "puff")).toBe(kitchenBefore + 60 - 40);
    expect(S().pord.find((o) => o.id === "PRD-2026-029")!.st).toBe("Dispatched");
  });
  it("refuses to distribute more than the kitchen holds", () => {
    as("prod");
    const before = S().tkt.length;
    S().distribute("salad", 9999, "rest");
    expect(S().tkt).toHaveLength(before);
  });
});

describe("procurement", () => {
  it("store raises a requisition, procurement orders and receives it", () => {
    as("store");
    S().setPrqDraft([{ it: "milk", qty: 80 }]);
    S().sendRequisition("Two counters affected");
    const p = S().prq[0];
    expect(p.lines[0].qty).toBe(80);
    expect(p.st).toBe("Sent");

    as("buyer");
    S().orderRequisition(p.id, [52], "Aavin Dairy Depot", "28-Aug-2026");
    expect(S().prq.find((x) => x.id === p.id)!.st).toBe("Ordered");
    expect(S().po).toHaveLength(1);

    const storeBefore = qty(S(), "store", "milk");
    S().receiveRequisition(p.id);
    expect(qty(S(), "store", "milk")).toBe(storeBefore + 80);
    expect(S().prq.find((x) => x.id === p.id)!.st).toBe("Received");
    expect(S().po[0].st).toBe("Received");
  });
});
