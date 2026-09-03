import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { IT, LOC, MENU, PL, RCP, USERS, homeLabel } from "../data/master";
import {
  cashCollected, costOf, freeToPromise, inTransit, isCashTender,
  onOrder, parOf, qty, recipeCost, resv,
} from "../lib/selectors";
import { bestBefore, fq, unitTotal } from "../lib/fmt";
import { seedPrq, seedTkt } from "../data/seed";
import { resetStore, S, as } from "./fixture";

beforeEach(resetStore);

/* ---------------------------------------------------------------- C1 */
describe("C1 · production consumes its ingredients", () => {
  it("draws every recipe ingredient down from the kitchen", () => {
    as("prod");
    const maida = qty(S(), "kitchen", "maida");
    const fill = qty(S(), "kitchen", "fill");
    S().makeProduct("puff", 10);
    const r = RCP.puff;
    expect(qty(S(), "kitchen", "puff")).toBe(34);
    expect(qty(S(), "kitchen", "maida")).toBeCloseTo(maida - r.l.find(([g]) => g === "maida")![1] * 10, 3);
    expect(qty(S(), "kitchen", "fill")).toBeCloseTo(fill - r.l.find(([g]) => g === "fill")![1] * 10, 3);
  });

  it("refuses to make more than the ingredients allow", () => {
    as("prod");
    const before = qty(S(), "kitchen", "puff");
    S().makeProduct("puff", 100000);
    expect(qty(S(), "kitchen", "puff")).toBe(before);
    expect(S().toast).toMatch(/short of/i);
  });

  it("stamps the batch with the quantity actually made", () => {
    as("prod");
    S().makeProduct("puff", 10);
    expect(S().batch[0].qty).toBe(10);
    expect(S().batch[0].it).toBe("puff");
  });
});

/* ---------------------------------------------------------------- C2 */
describe("C2 · kitchen tickets move like store tickets", () => {
  it("reserves rather than deducts when the kitchen dispatches", () => {
    as("prod");
    const before = qty(S(), "kitchen", "puff");
    S().distribute("puff", 5, "kiosk");
    expect(qty(S(), "kitchen", "puff")).toBe(before);
    expect(resv(S(), "kitchen", "puff")).toBe(5);
  });

  it("lets a kitchen ticket be handed over, then received", () => {
    as("prod");
    const before = qty(S(), "kitchen", "puff");
    const atKiosk = qty(S(), "kiosk", "puff");
    S().distribute("puff", 5, "kiosk");
    const t = S().tkt[S().tkt.length - 1];
    S().handover(t.id);
    expect(S().tkt.find((x) => x.id === t.id)!.st).toBe("Collected");
    expect(qty(S(), "kitchen", "puff")).toBe(before - 5);
    expect(resv(S(), "kitchen", "puff")).toBe(0);
    S().receiveTicket(t.id);
    expect(S().tkt.find((x) => x.id === t.id)!.st).toBe("Received");
    expect(qty(S(), "kiosk", "puff")).toBe(atKiosk + 5);
  });

  it("reserves rather than deducts when a production order is dispatched", () => {
    as("prod");
    const o = S().pord.find((x) => x.st === "Accepted")!;
    o.lines.forEach((l) => S().makeProduct(l.it, l.qty));
    const it = o.lines[0].it;
    const before = qty(S(), "kitchen", it);
    S().dispatchOrder(o.id);
    expect(qty(S(), "kitchen", it)).toBe(before);
    expect(resv(S(), "kitchen", it)).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------- C3 */
describe("C3 · the kitchen can actually request from the store", () => {
  it("creates a real request the store side can see", () => {
    as("prod");
    const before = S().req.length;
    S().requestFromStore("maida", 25);
    expect(S().req).toHaveLength(before + 1);
    const r = S().req[S().req.length - 1];
    expect(r.from).toBe("kitchen");
    expect(r.st).toBe("Request sent");
    expect(r.lines).toEqual([{ it: "maida", qty: 25, appr: 0 }]);
  });

  it("refuses a quantity of zero", () => {
    as("prod");
    const before = S().req.length;
    S().requestFromStore("maida", 0);
    expect(S().req).toHaveLength(before);
  });
});

/* ---------------------------------------------------------------- C4 */
describe("C4 · a trimmed request records its shortfall", () => {
  it("records the unapproved remainder on the line", () => {
    as("manager");
    const r = S().req.find((x) => x.id === "REQ-2026-0911")!;
    S().approveRequest(r.id, [12], "Store is tight");
    const after = S().req.find((x) => x.id === "REQ-2026-0911")!;
    expect(after.st).toBe("Partially approved");
    expect(after.lines[0].short).toBe(8);
  });

  it("records no shortfall when the store can cover the request in full", () => {
    as("manager");
    // REQ-0910 asks for 5 kg sugar and 1 kg butter, both comfortably in stock.
    const r = S().req.find((x) => x.id === "REQ-2026-0910")!;
    useApp.setState({ req: S().req.map((x) => x.id === r.id ? { ...x, st: "Request sent" as const } : x) });
    S().approveRequest(r.id, r.lines.map((l) => l.qty), "All of it");
    const after = S().req.find((x) => x.id === r.id)!;
    expect(after.st).toBe("Manager approved");
    expect(after.lines.every((l) => l.short === 0)).toBe(true);
  });
});

/* ---------------------------------------------------------------- C5 */
describe("C5 · open tickets from seed reserve their stock", () => {
  it("reserves the lines of every issued ticket at start-up", () => {
    const issued = seedTkt.filter((t) => t.st === "Issued");
    expect(issued.length).toBeGreaterThan(0);
    issued.forEach((t) => {
      t.lines.forEach((l) => {
        expect(resv(S(), t.from, l.it)).toBeGreaterThanOrEqual(l.qty);
      });
    });
  });

  it("frees the reservation when the seeded ticket is handed over", () => {
    as("store");
    const t = seedTkt.find((x) => x.st === "Issued" && x.from === "store")!;
    S().handover(t.id);
    expect(resv(S(), "store", t.lines[0].it)).toBe(0);
  });
});

/* ---------------------------------------------------------------- C6 */
describe("C6 · the same stock cannot be promised twice", () => {
  it("nets approved-but-unticketed quantities out of free to promise", () => {
    as("manager");
    const onHand = qty(S(), "store", "milk");
    S().approveRequest("REQ-2026-0911", [12], "");
    expect(qty(S(), "store", "milk")).toBe(onHand);
    expect(freeToPromise(S(), "store", "milk")).toBe(onHand - 12);
  });

  it("clamps an approval to what is still free to promise", () => {
    as("manager");
    S().approveRequest("REQ-2026-0911", [12], "");
    S().setDraft([]);
    useApp.setState({
      req: [...S().req, {
        id: "REQ-2026-0999", from: "coffee", by: "Kavitha Raman", at: "10:00",
        lines: [{ it: "milk", qty: 10, appr: 0 }], st: "Request sent", ticket: null,
        mgrNote: "", hist: [],
      }],
    });
    S().approveRequest("REQ-2026-0999", [10], "");
    const after = S().req.find((x) => x.id === "REQ-2026-0999")!;
    expect(after.lines[0].appr).toBe(0);
  });
});

/* ---------------------------------------------------------------- H1 */
describe("H1 · made items cost what their recipe costs", () => {
  it("computes cappuccino from its ingredients plus overhead", () => {
    const r = RCP.capp;
    const raw = r.l.reduce((t, [g, q]) => t + q * IT[g].cost, 0);
    expect(recipeCost("capp")).toBeCloseTo(raw * (1 + r.ov / 100), 2);
    expect(recipeCost("capp")).toBeGreaterThan(0);
  });

  it("uses the recipe cost for a made item and the item cost otherwise", () => {
    expect(costOf("capp")).toBeCloseTo(recipeCost("capp"), 4);
    expect(costOf("juice")).toBe(IT.juice.cost);
  });
});

/* ---------------------------------------------------------------- H3 */
describe("H3 · a removed product can be put back", () => {
  it("restores a product to the outlet menu", () => {
    as("manager");
    S().removeProduct("coffee", "juice");
    expect(S().menu.coffee).not.toContain("juice");
    S().addProduct("coffee", "juice");
    expect(S().menu.coffee).toContain("juice");
  });

  it("does not list the same product twice", () => {
    as("manager");
    S().addProduct("coffee", "juice");
    expect(S().menu.coffee.filter((x) => x === "juice")).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------- H4 */
describe("H4 · only cash counts as collected", () => {
  it("separates settled cash from billed value", () => {
    expect(isCashTender("Cash")).toBe(true);
    expect(isCashTender("Patient bill")).toBe(false);
    expect(isCashTender("Staff credit")).toBe(false);
    expect(isCashTender("Dept")).toBe(false);
    expect(isCashTender("UPI")).toBe(false);
  });

  it("sums only the cash bills", () => {
    const bills = [
      { pay: "Cash", tot: 100 }, { pay: "Patient bill", tot: 50 }, { pay: "UPI", tot: 25 },
    ] as Parameters<typeof cashCollected>[0];
    expect(cashCollected(bills)).toBe(100);
  });
});

/* ---------------------------------------------------------------- H6 */
describe("H6 · the approver is recorded", () => {
  it("names the manager who approved, not the operator who raised", () => {
    as("manager");
    const me = S().user!.n;
    const raiser = S().req.find((x) => x.id === "REQ-2026-0911")!.by;
    S().approveRequest("REQ-2026-0911", [12], "");
    const after = S().req.find((x) => x.id === "REQ-2026-0911")!;
    expect(after.apprBy).toBe(me);
    expect(after.apprBy).not.toBe(raiser);
  });
});

/* ---------------------------------------------------------------- H7 */
describe("H7 · rejection needs a reason", () => {
  it("refuses to reject without a note", () => {
    as("manager");
    S().rejectRequest("REQ-2026-0912", "   ");
    expect(S().req.find((x) => x.id === "REQ-2026-0912")!.st).toBe("Request sent");
    expect(S().toast).toMatch(/reason/i);
  });

  it("rejects when a reason is given", () => {
    as("manager");
    S().rejectRequest("REQ-2026-0912", "Kiosk is overstocked already");
    const after = S().req.find((x) => x.id === "REQ-2026-0912")!;
    expect(after.st).toBe("Rejected");
    expect(after.mgrNote).toBe("Kiosk is overstocked already");
  });
});

/* ---------------------------------------------------------------- H8 */
describe("H8 · no seeded price breaches its MRP", () => {
  it("keeps every listed price at or below the printed MRP", () => {
    (["A", "B"] as const).forEach((list) => {
      Object.entries(PL[list]).forEach(([it, price]) => {
        const mrp = IT[it]?.mrp;
        if (mrp != null) expect(price, `${list}/${it}`).toBeLessThanOrEqual(mrp);
      });
    });
  });
});

/* ---------------------------------------------------------------- H9 */
describe("H9 · best-before says which day it means", () => {
  it("marks a best-before that lands on the next day", () => {
    const evening = new Date("2026-08-29T20:34:00");
    expect(bestBefore(evening, 12)).toMatch(/tomorrow/i);
  });

  it("leaves a same-day best-before as a plain time", () => {
    const morning = new Date("2026-08-29T06:40:00");
    const out = bestBefore(morning, 12);
    expect(out).not.toMatch(/tomorrow/i);
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });
});

/* ---------------------------------------------------------------- M1 */
describe("M1 · non-cash tenders need a payer", () => {
  it("refuses a patient bill with no patient attached", () => {
    as("counter");
    S().addToCart("coffee", "juice", 1);
    const before = S().bills.length;
    S().pay("coffee", "Patient bill");
    expect(S().bills).toHaveLength(before);
    expect(S().toast).toMatch(/patient/i);
  });

  it("posts the bill against the payer it was given", () => {
    as("counter");
    S().addToCart("coffee", "juice", 1);
    S().pay("coffee", "Patient bill", { kind: "patient", id: "IP-4471", name: "Anand Kumar" });
    const b = S().bills[0];
    expect(b.pay).toBe("Patient bill");
    expect(b.payer?.id).toBe("IP-4471");
  });

  it("needs no payer for cash", () => {
    as("counter");
    S().addToCart("coffee", "juice", 1);
    const before = S().bills.length;
    S().pay("coffee", "Cash");
    expect(S().bills).toHaveLength(before + 1);
  });
});

/* ---------------------------------------------------------------- M3 */
describe("M3 · what is already on order is visible", () => {
  it("counts quantities pending on the procurement pool", () => {
    // onOrder is derived from what is approved-and-pending plus live purchase
    // orders (Task 11) — a requisition still "Sent" has not been approved and
    // contributes nothing on its own, so this picks from the approved pool.
    const pool = seedPrq
      .filter((p) => p.st === "Approved" || p.st === "Partially approved")
      .flatMap((p) => p.lines.filter((l) => l.appr > l.ordered));
    expect(pool.length).toBeGreaterThan(0);
    const it = pool[0].it;
    const pending = pool[0].appr - pool[0].ordered;
    // Exact, not >=: pool[0] (maida, off PRQ-2026-014) is the seed's only
    // pending line for this item and no purchase order references it, so
    // onOrder must equal this line's pending amount exactly — a loose bound
    // would still pass if onOrder over-counted.
    expect(onOrder(S(), it)).toBe(pending);
  });
});

/* ---------------------------------------------------------------- M8 */
describe("M8 · stock in transit is visible", () => {
  it("reports quantity handed over but not yet received", () => {
    as("store");
    const t = seedTkt.find((x) => x.st === "Issued" && x.from === "store")!;
    const it = t.lines[0].it;
    expect(inTransit(S(), it)).toBe(0);
    S().handover(t.id);
    expect(inTransit(S(), it)).toBe(t.lines[0].qty);
    S().receiveTicket(t.id);
    expect(inTransit(S(), it)).toBe(0);
  });
});

/* ---------------------------------------------------------------- M9 */
describe("M9 · the kitchen cannot push stock a counter cannot sell", () => {
  it("refuses a destination that does not list the product", () => {
    as("prod");
    expect(MENU.coffee).not.toContain("puff");
    const before = S().tkt.length;
    S().distribute("puff", 5, "coffee");
    expect(S().tkt).toHaveLength(before);
    expect(S().toast).toMatch(/not listed/i);
  });

  it("allows a destination that lists it", () => {
    as("prod");
    const before = S().tkt.length;
    S().distribute("puff", 5, "kiosk");
    expect(S().tkt).toHaveLength(before + 1);
  });
});

/* ---------------------------------------------------------------- M11 */
describe("M11 · reorder levels are per location", () => {
  it("gives a counter a smaller reorder level than the central store", () => {
    expect(parOf("coffee", "juice")).toBeLessThan(parOf("store", "juice"));
  });

  it("leaves the central store on the item's own reorder level", () => {
    expect(parOf("store", "juice")).toBe(IT.juice.rl);
  });

  it("does not flag a healthy counter as low", () => {
    expect(qty(S(), "coffee", "water")).toBeGreaterThan(parOf("coffee", "water"));
  });
});

/* ---------------------------------------------------------------- M4 */
describe("M4 · quantities are not summed across units", () => {
  it("shows a single line in its own unit", () => {
    expect(unitTotal([{ it: "milk", qty: 20 }])).toBe("20.000 L");
  });

  it("keeps unlike units apart", () => {
    const out = unitTotal([{ it: "milk", qty: 10 }, { it: "cup", qty: 500 }]);
    expect(out).toMatch(/10\.000 L/);
    expect(out).toMatch(/500 nos/);
    expect(out).not.toMatch(/510/);
  });

  it("adds up lines that share a unit", () => {
    expect(unitTotal([{ it: "juice", qty: 24 }, { it: "water", qty: 12 }])).toBe("36 nos");
  });
});

/* ------------------------------------------------- UA-14 · yield capture */
describe("UA-14 · a batch records the yield it actually got", () => {
  it("consumes ingredients for the quantity started, not the quantity yielded", () => {
    as("prod");
    const maida = qty(S(), "kitchen", "maida");
    S().makeProduct("puff", 60, 58, "Oven tray dropped");
    const per = RCP.puff.l.find(([g]) => g === "maida")![1];
    expect(qty(S(), "kitchen", "maida")).toBeCloseTo(maida - per * 60, 3);
  });

  it("posts the actual yield to finished goods", () => {
    as("prod");
    const before = qty(S(), "kitchen", "puff");
    S().makeProduct("puff", 60, 58, "Oven tray dropped");
    expect(qty(S(), "kitchen", "puff")).toBe(before + 58);
  });

  it("records the variance and its reason on the batch", () => {
    as("prod");
    S().makeProduct("puff", 60, 58, "Oven tray dropped");
    const b = S().batch[0];
    expect(b.qty).toBe(60);
    expect(b.made).toBe(58);
    expect(b.note).toBe("Oven tray dropped");
  });

  it("treats an omitted yield as a full one", () => {
    as("prod");
    S().makeProduct("puff", 10);
    const b = S().batch[0];
    expect(b.qty).toBe(10);
    expect(b.made).toBe(10);
  });

  it("refuses a yield greater than the quantity started", () => {
    as("prod");
    const before = qty(S(), "kitchen", "puff");
    S().makeProduct("puff", 10, 25);
    expect(qty(S(), "kitchen", "puff")).toBe(before);
    expect(S().toast).toMatch(/yield/i);
  });
});

/* ------------------------------------------- fq · countable but fractional */
describe("countable units still show a fraction when there is one", () => {
  it("keeps whole counts whole", () => {
    expect(fq(6, "bread")).toBe("6");
    expect(fq(500, "cup")).toBe("500");
  });

  it("does not round a fractional count away to zero", () => {
    // A sandwich takes a tenth of a loaf; "0 nos Bread loaf" is not a recipe.
    expect(fq(0.1, "bread")).toBe("0.100");
    expect(fq(0.035, "maida")).toBe("0.035");
  });
});

/* ------------------------------- a production order dispatches whole */
describe("a production order goes out whole, to the place that raised it", () => {
  /** The seeded two-item order: sandwiches and salad for the Snack Kiosk. */
  const twoItem = () => S().pord.find((x) => x.lines.length > 1)!;

  it("puts every item on one ticket addressed to the ordering outlet", () => {
    as("prod");
    const o = twoItem();
    expect(o.lines).toHaveLength(2);
    o.lines.forEach((l) => S().makeProduct(l.it, l.qty));

    S().dispatchOrder(o.id);

    const raised = S().tkt.filter((t) => t.req === o.id);
    // One order, one ticket — not one ticket per item.
    expect(raised).toHaveLength(1);
    const t = raised[0];
    expect(t.from).toBe("kitchen");
    expect(t.to).toBe(o.from);
    expect(t.lines).toHaveLength(o.lines.length);
    o.lines.forEach((l) => expect(t.lines.find((x) => x.it === l.it)!.qty).toBe(l.qty));
    expect(S().pord.find((x) => x.id === o.id)!.st).toBe("Dispatched");
  });

  it("lands both items, in full, on the ordering outlet's shelf", () => {
    as("prod");
    const o = twoItem();
    o.lines.forEach((l) => S().makeProduct(l.it, l.qty));
    const before = o.lines.map((l) => qty(S(), o.from, l.it));

    S().dispatchOrder(o.id);
    const t = S().tkt.find((x) => x.req === o.id)!;
    S().handover(t.id, t.otp);
    S().receiveTicket(t.id);

    o.lines.forEach((l, i) => expect(qty(S(), o.from, l.it)).toBe(before[i] + l.qty));
  });

  it("dispatches nothing when one item of the order is short, and names it", () => {
    as("prod");
    const o = twoItem();
    // Only the first item is made — a part dispatch must not slip through.
    S().makeProduct(o.lines[0].it, o.lines[0].qty);

    S().dispatchOrder(o.id);

    expect(S().tkt.some((t) => t.req === o.id)).toBe(false);
    expect(S().pord.find((x) => x.id === o.id)!.st).not.toBe("Dispatched");
    expect(S().toast).toMatch(new RegExp(IT[o.lines[1].it].n, "i"));
  });

  it("refuses to raise a second ticket for an order already dispatched", () => {
    as("prod");
    const o = twoItem();
    o.lines.forEach((l) => S().makeProduct(l.it, l.qty));
    S().dispatchOrder(o.id);
    const after = S().tkt.length;

    S().dispatchOrder(o.id);

    expect(S().tkt).toHaveLength(after);
    expect(S().toast).toMatch(/already gone out/i);
  });
});

describe("a rejection records who made the call", () => {
  it("stores the decider on the request, not only in the history", () => {
    as("manager");
    S().rejectRequest("REQ-2026-0911", "Nothing to spare until the delivery lands");
    const r = S().req.find((x) => x.id === "REQ-2026-0911")!;
    expect(r.st).toBe("Rejected");
    expect(r.apprBy).toBe("Ramesh Kumar");
    expect(r.mgrNote).toContain("Nothing to spare");
  });
  it("refuses to reject without a reason", () => {
    as("manager");
    S().rejectRequest("REQ-2026-0912", "   ");
    expect(S().req.find((x) => x.id === "REQ-2026-0912")!.st).toBe("Request sent");
  });
});

describe("two shops deal with each other directly", () => {
  it("one shop asks another, the other grants, and a ticket carries it across", () => {
    as("counter");                                   // Kavitha at the Coffee Shop
    S().askShop("kiosk", "bisc", 4, "Out until the store opens");
    const ask = S().shopAsks[0];
    expect(ask.from).toBe("coffee");
    expect(ask.to).toBe("kiosk");
    expect(ask.st).toBe("Asked");

    const kioskBefore = qty(S(), "kiosk", "bisc");
    const coffeeBefore = qty(S(), "coffee", "bisc");
    const tickets = S().tkt.length;

    S().answerShopAsk(ask.id, 4);
    const answered = S().shopAsks.find((a) => a.id === ask.id)!;
    expect(answered.st).toBe("Sent");
    expect(answered.grant).toBe(4);
    expect(S().tkt).toHaveLength(tickets + 1);

    // reserved at the giving shop, nothing has physically moved yet
    const t = S().tkt[S().tkt.length - 1];
    expect(t.from).toBe("kiosk");
    expect(t.to).toBe("coffee");
    expect(qty(S(), "kiosk", "bisc")).toBe(kioskBefore);
    expect(resv(S(), "kiosk", "bisc")).toBe(4);
    expect(t.otp).toMatch(/^\d{6}$/);

    S().handover(t.id, t.otp);
    expect(qty(S(), "kiosk", "bisc")).toBe(kioskBefore - 4);
    S().receiveTicket(t.id);
    expect(qty(S(), "coffee", "bisc")).toBe(coffeeBefore + 4);
  });

  it("a wrong OTP does not release the goods", () => {
    as("counter");
    S().askShop("kiosk", "bisc", 2, "");
    S().answerShopAsk(S().shopAsks[0].id, 2);
    const t = S().tkt[S().tkt.length - 1];
    const before = qty(S(), "kiosk", "bisc");
    S().handover(t.id, "000000");
    expect(S().tkt.find((x) => x.id === t.id)!.st).toBe("Issued");
    expect(qty(S(), "kiosk", "bisc")).toBe(before);
  });

  it("declining needs a reason and sends nothing", () => {
    as("counter");
    S().askShop("kiosk", "bisc", 3, "");
    const id = S().shopAsks[0].id;
    const tickets = S().tkt.length;
    S().declineShopAsk(id, "   ");
    expect(S().shopAsks.find((a) => a.id === id)!.st).toBe("Asked");
    S().declineShopAsk(id, "Needed for the evening rush");
    expect(S().shopAsks.find((a) => a.id === id)!.st).toBe("Declined");
    expect(S().tkt).toHaveLength(tickets);
  });
});

describe("support is customer care for the portal", () => {
  it("raises a ticket carrying the screen it is about, and threads the reply", () => {
    as("counter");
    S().raiseTicket({
      topic: "A number looks wrong", subject: "Cash collected stuck at zero",
      body: "Sales is climbing but cash is not.", priority: "Urgent", screen: "Dashboard",
    });
    const t = S().tickets[0];
    expect(t.st).toBe("Open");
    expect(t.screen).toBe("Dashboard");
    expect(t.by).toBe("Kavitha Raman");
    expect(t.messages).toHaveLength(1);

    S().replyToTicket(t.id, "Still happening after a refresh.");
    expect(S().tickets[0].messages).toHaveLength(2);

    S().setTicketStatus(t.id, "Resolved");
    S().rateTicket(t.id, 5);
    expect(S().tickets[0].st).toBe("Resolved");
    expect(S().tickets[0].rating).toBe(5);
  });

  it("a reply on a ticket waiting on the user hands it back to support", () => {
    as("counter");
    const waiting = S().tickets.find((t) => t.st === "Waiting on you")!;
    S().replyToTicket(waiting.id, "Yes, that covers it — thank you.");
    expect(S().tickets.find((t) => t.id === waiting.id)!.st).toBe("With support");
  });

  it("refuses a ticket with no subject", () => {
    as("counter");
    const before = S().tickets.length;
    S().raiseTicket({ topic: "Something else", subject: "  ", body: "x", priority: "Low", screen: "Dashboard" });
    expect(S().tickets).toHaveLength(before);
  });
});

describe("a new product a shop wants goes to procurement, not to support", () => {
  it("the manager raises it and procurement answers it", () => {
    as("manager");
    const before = S().productReqs.length;
    S().requestNewProduct({ name: "Sugar-free iced tea 250ml", why: "Diabetic attenders ask daily", forLoc: "coffee" });
    expect(S().productReqs).toHaveLength(before + 1);
    const r = S().productReqs[0];
    expect(r.st).toBe("Requested");
    expect(r.by).toBe("Ramesh Kumar");
    // it must not have landed on the support desk
    expect(S().tickets.some((t) => t.subject.includes("Sugar-free"))).toBe(false);

    as("buyer");
    S().answerProductRequest(r.id, "Declined", "Vendor cannot supply reliably");
    expect(S().productReqs.find((p) => p.id === r.id)!.st).toBe("Declined");
  });

  it("procurement creates the item and the request links to it", () => {
    as("manager");
    S().requestNewProduct({ name: "Iced lemon tea 300ml", why: "Warm-weather demand", forLoc: "kiosk" });
    const r = S().productReqs[0];

    as("buyer");
    const before = new Set(Object.keys(IT));
    S().createItem(
      { key: "", name: "Iced lemon tea 300ml", code: "", unit: "nos", type: "MRP", group: "", hsn: "", gst: 5, reorder: 0, cost: 18, mrp: 25 },
      "store", 0,
    );
    const newKey = Object.keys(IT).find((k) => !before.has(k))!;
    expect(newKey).toBeDefined();
    expect(IT[newKey].mrp).toBe(25);

    S().answerProductRequest(r.id, "Created", `Added as ${IT[newKey].c}`, newKey);
    const answered = S().productReqs.find((p) => p.id === r.id)!;
    expect(answered.st).toBe("Created");
    expect(answered.itemKey).toBe(newKey);
  });
});

describe("a role that spans every outlet is not shown living in one", () => {
  it("the outlet manager reads as covering every shop, not based at one", () => {
    const manager = USERS.find((u) => u.r === "manager")!;
    expect(homeLabel(manager)).toBe("All outlets");
  });
  it("the procurement officer carries no shop suffix at all", () => {
    const buyer = USERS.find((u) => u.r === "buyer")!;
    expect(homeLabel(buyer)).toBeNull();
  });
  it("a role tied to one place still shows it", () => {
    const counter = USERS.find((u) => u.r === "counter")!;
    const store = USERS.find((u) => u.r === "store")!;
    const kitchen = USERS.find((u) => u.r === "prod")!;
    expect(homeLabel(counter)).toBe(LOC[counter.loc].n);
    expect(homeLabel(store)).toBe(LOC.store.n);
    expect(homeLabel(kitchen)).toBe(LOC.kitchen.n);
    expect(kitchen.rl).toBe("Kitchen In-charge");
  });
});

describe("a shop-to-shop ask is answerable from the receiving counter", () => {
  it("seeds one waiting ask in each direction, so the flow is visible on sign-in", () => {
    const inbound = S().shopAsks.find((a) => a.to === "coffee" && a.st === "Asked");
    expect(inbound, "the Coffee Shop must have something to answer").toBeTruthy();
    expect(inbound!.from).toBe("kiosk");
    // it must be grantable in full from what that counter actually holds,
    // or the first thing anyone tries hits the not-enough-stock guard
    expect(inbound!.qty).toBeLessThanOrEqual(qty(S(), "coffee", inbound!.it));
  });

  it("granting it moves stock the other way, on a ticket", () => {
    as("counter");
    const ask = S().shopAsks.find((a) => a.to === "coffee" && a.st === "Asked")!;
    const before = S().tkt.length;
    S().answerShopAsk(ask.id, ask.qty);
    expect(S().tkt).toHaveLength(before + 1);
    const t = S().tkt[S().tkt.length - 1];
    expect(t.from).toBe("coffee");
    expect(t.to).toBe("kiosk");
    expect(S().shopAsks.find((a) => a.id === ask.id)!.st).toBe("Sent");
  });

  it("both counters have a login, so either end can be signed into", () => {
    const counters = USERS.filter((u) => u.r === "counter");
    expect(counters.length).toBeGreaterThanOrEqual(2);
    expect(new Set(counters.map((u) => u.loc)).size).toBeGreaterThanOrEqual(2);
  });
});
