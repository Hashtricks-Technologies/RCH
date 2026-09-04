import { beforeEach, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { IT, LOC, PL, RCP, USERS, homeLabel } from "../data/master";
import {
  cashCollected, costOf, inTransit, isCashTender,
  onOrder, parOf, qty, recipeCost, resv,
} from "../lib/selectors";
import { fq, fromWireBestBefore, unitTotal } from "../lib/fmt";
import { seedPrq, seedTkt } from "../data/seed";
import { resetStore, S, as } from "./fixture";

beforeEach(resetStore);

/* ---------------------------------------------------------------- C1
 * C1 · production consumes its ingredients. The server's since Phase 4:
 * apps/api/src/modules/production/production.test.ts pins all three halves — "consumes the
 * recipe for what was started and books only what came good (C1, UA-14)" for the depletion,
 * "names the ingredient that ran out, and moves nothing (C1)" for the refusal, and the batch
 * row's `qty`/`made` in the same first case. The store call that reaches that route is in
 * writes.test.ts, "sends what was started and what came good". */

/* ---------------------------------------------------------------- C2
 * C2 · kitchen tickets move like store tickets. Both halves are the server's since Phase 3:
 * apps/api/src/modules/production/production.test.ts pins the reservation — "puts every item
 * on one ticket addressed to the ordering outlet, and reserves rather than moves" and
 * "reserves at the kitchen and raises the ticket the outlet collects against" — and
 * apps/api/src/modules/tickets/tickets.test.ts pins the movement, "lets the kitchen hand its
 * own ticket over (C2)" and "books the stock in and closes the request behind it". The store
 * calls that reach those routes are in writes.test.ts. */

/* ---------------------------------------------------------------- C3
 * C3 · the kitchen can actually request from the store. POST /requests admits `prod` since
 * Phase 3: apps/api/src/modules/requests/requests.test.ts pins both halves — "lets the kitchen
 * raise one too, from the kitchen" and "refuses a line with no quantity, in the operator's
 * words (C3)". */

/* ---------------------------------------------------------------- C4
 * C4 · a trimmed request records its shortfall. The approval runs server-side since Phase 3:
 * requests.test.ts pins "trims to what the store can cover and records the shortfall (C4, C6)"
 * and "approves in full and forwards it, with no shortfall". */

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

  // Handover frees the hold on the server now — tickets.test.ts "moves the stock out on the
  // OTP, releases the hold, and closes nothing else".
});

/* ---------------------------------------------------------------- C6
 * C6 · the same stock cannot be promised twice. The netting is the server's since Phase 3:
 * requests.test.ts pins "nets an approval already made against the next one (C6)" and
 * "trims to what the store can cover and records the shortfall (C4, C6)". The rule itself is
 * still one shared `freeToPromise` in packages/domain. */

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

/* ---------------------------------------------------------------- H3
 * H3 · a removed product can be put back. The menu is the server's since Phase 2:
 * apps/api/src/modules/catalog/catalog.test.ts pins both halves of this tag — "adds and
 * removes a menu item, preserving the order of the rest" and "422s adding an item already
 * on the menu". The store call that reaches those routes is in writes.test.ts. */

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

/* ---------------------------------------------------------------- H6
 * H6 · the approver is recorded. The server stamps it from the token: requests.test.ts
 * "names the manager who approved, not the operator who raised (H6)". */

/* ---------------------------------------------------------------- H7
 * H7 · rejection needs a reason. Both halves are the server's: requests.test.ts "refuses to
 * reject without a reason (H7)" and "rejects when a reason is given, and issues no ticket".
 * writes.test.ts proves the refusal reaches the manager word for word. */

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
  // The wording itself is pinned in packages/domain/src/shelf.test.ts, where it now lives
  // (the server puts it in a toast, this table puts it in a column). What is left to check
  // here is that the batch log reads an ISO instant from the wire through that wording.
  it("marks a best-before that lands on the next day", () => {
    const due = new Date(Date.now() + 30 * 3600_000).toISOString();
    expect(fromWireBestBefore(due)).toMatch(/^\d{2}:\d{2} /);
  });

  it("leaves a best-before a few minutes out as a plain time", () => {
    // Five minutes from now is the same IST day unless the run straddles midnight, which the
    // suite's own clock decides; skip that one minute rather than pin a flake.
    const due = new Date(Date.now() + 5 * 60_000);
    if (due.getDate() === new Date().getDate()) expect(fromWireBestBefore(due.toISOString())).toMatch(/^\d{2}:\d{2}$/);
  });
});

/* ---------------------------------------------------------------- M1
 * M1 · non-cash tenders need a payer. The sale is POST /bills since Phase 2:
 * apps/api/src/modules/pos/pos.test.ts pins this tag — "wants a patient before it takes a
 * patient bill", "wants a staff member before it takes a staff credit", "wants a department
 * before it takes a dept bill", and "names the payer on a credit tender". writes.test.ts
 * proves the payer this store sends reaches the body. */

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
  // `inTransit` is still a UI selector over whatever the tickets say, so the ticket's status
  // is driven directly here — the moves that set it belong to tickets.test.ts.
  it("reports quantity handed over but not yet received", () => {
    const t = seedTkt.find((x) => x.st === "Issued" && x.from === "store")!;
    const it = t.lines[0].it;
    expect(inTransit(S(), it)).toBe(0);
    useApp.setState({ tkt: S().tkt.map((x) => (x.id === t.id ? { ...x, st: "Collected" as const } : x)) });
    expect(inTransit(S(), it)).toBe(t.lines[0].qty);
    useApp.setState({ tkt: S().tkt.map((x) => (x.id === t.id ? { ...x, st: "Received" as const } : x)) });
    expect(inTransit(S(), it)).toBe(0);
  });
});

/* ---------------------------------------------------------------- M9
 * M9 · the kitchen cannot push stock a counter cannot sell. POST /distributions holds it:
 * production.test.ts "refuses a destination that does not list the product (M9)", with the
 * happy path in "reserves at the kitchen and raises the ticket the outlet collects against". */

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

/* ------------------------------------------------- UA-14 · yield capture
 * The server's since Phase 4: production.test.ts's "consumes the recipe for what was started
 * and books only what came good (C1, UA-14)", "treats an omitted yield as a full one", "takes
 * a whole tray lost: the ingredients go, nothing reaches the rack" and "refuses a yield
 * greater than the quantity started, and writes nothing at all". */

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

/* ------------------------------- a production order dispatches whole
 * All four cases are the server's since Phase 3, on POST /prod-orders/:id/dispatch:
 * production.test.ts "puts every item on one ticket addressed to the ordering outlet, and
 * reserves rather than moves", "dispatches nothing when one item is short, and names every
 * item that is" and "refuses to raise a second ticket for an order already dispatched"; the
 * landing half is tickets.test.ts "books the stock in and closes the request behind it". */

/* A rejection records who made the call — the server stamps `apprBy` from the token and
 * refuses an empty reason: requests.test.ts "names the manager who approved, not the operator
 * who raised (H6)" and "refuses to reject without a reason (H7)". */

/* Two shops deal with each other directly — the whole exchange is server-side since Phase 3:
 * shopasks.test.ts "asks the other shop directly, not the manager", "grants it, reserves at
 * the shop that holds it, and raises the ticket the asker collects" and "needs a reason the
 * other shop can read"; tickets.test.ts "refuses a wrong OTP and moves nothing". */

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

  // Granting it is one server call that both books the grant and raises the ticket —
  // shopasks.test.ts "grants it, reserves at the shop that holds it, and raises the ticket
  // the asker collects".

  it("both counters have a login, so either end can be signed into", () => {
    const counters = USERS.filter((u) => u.r === "counter");
    expect(counters.length).toBeGreaterThanOrEqual(2);
    expect(new Set(counters.map((u) => u.loc)).size).toBeGreaterThanOrEqual(2);
  });
});

/* Declining an inbound ask takes two steps — shopasks.test.ts "needs a reason the other shop
 * can read" and "declines with the reason, and issues no ticket". */
