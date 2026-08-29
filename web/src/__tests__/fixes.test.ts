import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { IT, MENU, PL, RCP } from "../data/master";
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
    S().distribute("puff", 5, "rest");
    expect(qty(S(), "kitchen", "puff")).toBe(before);
    expect(resv(S(), "kitchen", "puff")).toBe(5);
  });

  it("lets a kitchen ticket be handed over, then received", () => {
    as("prod");
    const before = qty(S(), "kitchen", "puff");
    S().distribute("puff", 5, "rest");
    const t = S().tkt[S().tkt.length - 1];
    S().handover(t.id);
    expect(S().tkt.find((x) => x.id === t.id)!.st).toBe("Collected");
    expect(qty(S(), "kitchen", "puff")).toBe(before - 5);
    expect(resv(S(), "kitchen", "puff")).toBe(0);
    S().receiveTicket(t.id);
    expect(S().tkt.find((x) => x.id === t.id)!.st).toBe("Received");
    expect(qty(S(), "rest", "puff")).toBe(17);
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
    expect(onOrder(S(), it)).toBeGreaterThanOrEqual(pending);
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
    S().distribute("puff", 5, "rest");
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
