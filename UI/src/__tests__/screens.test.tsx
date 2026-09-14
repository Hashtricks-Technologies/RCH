import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentType, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { useApp } from "../store";
import { NAV } from "../nav";
import { DRAWERS } from "../drawers";
import Settings from "../pages/Settings";
import AdminUsers from "../pages/AdminUsers";
import AdminDashboard from "../pages/AdminDashboard";
import AdminSupport from "../pages/AdminSupport";
import Issues from "../pages/Support";
import Login from "../pages/Login";
import { screens as counter } from "../roles/counter";
import { screens as manager } from "../roles/manager";
import { screens as store } from "../roles/store";
import { screens as prod } from "../roles/prod";
import { screens as buyer } from "../roles/buyer";
import { groupPool, picksFor, type PoolGroup } from "../roles/buyer/ProcurementList";
import { REPORTS } from "../roles/store/Reports";
import { bodyKey } from "../roles/manager/ApprovalDrawer";
import { IT as FXIT, USERS, seedVendors } from "@rch/contract/fixtures";
// ---- item patch ----
import { IT, LOC, OUTLETS } from "../data/master";
import { activeItems, madeItems } from "../lib/selectors";
import { Alert } from "../ui/kit";
import type { PoolLine } from "../lib/selectors";
import type { Bill, Dated, DatedDoc, Role, StockRequest, SupportTicket, Ticket, Trailed } from "../types";
import { as, resetStore } from "./fixture";

// Nothing in production code carries data any more: the registries are empty until a snapshot
// lands, so the roles this suite iterates come from the fixtures (which is where a test reads
// them, per spec 5.1) and each case seeds the demo hospital before it renders.
beforeEach(resetStore);

const REGISTRY: Record<Role, Record<string, ComponentType>> = { counter, manager, store, prod, buyer };

/** Render on the client, the way the app actually runs. */
function render(el: ReactElement): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, el)); });
  const html = host.innerHTML;
  act(() => { root.unmount(); });
  host.remove();
  return html;
}

describe("every screen renders for its role", () => {
  // Not the admin-flagged fixture account - it has no operational nav (root CLAUDE.md), so
  // there is no `NAV[u.r]` screen of its own for this loop to render.
  for (const u of USERS.filter((u) => !u.admin)) {
    for (const k of NAV[u.r].flatMap((g) => g.items.map((i) => i.k))) {
      it(`${u.r}/${k}`, () => {
        act(() => { as(u.r); });
        const C = k === "settings" ? Settings : k === "issues" ? Issues : REGISTRY[u.r][k];
        expect(C, `no component registered for ${u.r}/${k}`).toBeTruthy();
        expect(render(createElement(C)).length).toBeGreaterThan(400);
      });
    }
  }
});

describe("the sidebar matches the screen registry", () => {
  for (const u of USERS.filter((u) => !u.admin)) {
    it(`${u.r}`, () => {
      const navKeys = NAV[u.r].flatMap((g) => g.items.map((i) => i.k)).filter((k) => k !== "settings" && k !== "issues");
      expect(navKeys.sort()).toEqual(Object.keys(REGISTRY[u.r]).sort());
    });
  }
});

describe("a role cannot reach another role's screens", () => {
  it("counter has no approvals, prices, issue or requisitions", () => {
    const keys = NAV.counter.flatMap((g) => g.items.map((i) => i.k));
    for (const forbidden of ["approvals", "prices", "issue", "procure", "requisitions", "orders", "make"])
      expect(keys).not.toContain(forbidden);
  });
  it("only the counter sells", () => {
    for (const r of ["manager", "store", "prod", "buyer"] as Role[])
      expect(NAV[r].flatMap((g) => g.items.map((i) => i.k))).not.toContain("pos");
  });
  it("every role has settings", () => {
    for (const r of Object.keys(NAV) as Role[])
      expect(NAV[r].flatMap((g) => g.items.map((i) => i.k))).toContain("settings");
  });
});

// The counter's staff-credit warning used to be pinned here by comparing two literals, which
// rendered nothing and so could not have caught the screen saying something else. It is a
// render-level case in `writes.test.ts` now ("puts the server's own ceiling and payer on
// screen, in the server's own words"), where a stubbed `GET /reports/credit/:kind/:id` can
// supply the figures the sentence is built from.

describe("drawers render", () => {
  /**
   * What to open each registered drawer over: the id it reads, and the role whose session makes
   * that id reachable. The loop below iterates `DRAWERS` itself rather than this map, so a drawer
   * registered without a row here fails the suite by name - the same coupling `NAV × screens` has,
   * and the reason the hand-written list this replaced had drifted eight keys behind the registry
   * (`adjstock`, `bnewitem`, `item`, `pnew`, `sissue`, `sitem`, `sprq`, `sup` were all unrendered).
   *
   * `"new"` is the empty-form id three of them take; a location key is the id `adjstock` takes,
   * because a write-off names its shelf rather than a document.
   */
  const OPEN_OVER: Record<string, [id: string, role: Role]> = {
    adjstock: ["coffee", "manager"],
    baddpool: ["new", "buyer"],
    bgrn: ["PO-2026-0141", "buyer"],
    bnewitem: ["new", "buyer"],
    bpo: ["PO-2026-0140", "buyer"],
    bprq: ["PRQ-2026-013", "buyer"],
    bven: ["VN-001", "buyer"],
    cbill: ["CF/1187", "counter"],
    cconfig: ["juice", "counter"],
    // ---- prod-order raise ---- the raiser's side of a production order, and the manager's way
    // of booking one. `korder` opens on nothing in particular, so its id is a placeholder.
    cpord: ["PRD-2026-029", "counter"],
    creq: ["REQ-2026-0911", "counter"],
    ctkt: ["TKT-0440", "counter"],
    item: ["chips", "manager"],
    korder: ["new", "manager"],
    mreq: ["REQ-2026-0911", "manager"],
    pnew: ["new", "prod"],
    pord: ["PRD-2026-029", "prod"],
    ptkt: ["TKT-0440", "prod"],
    sissue: ["REQ-2026-0910", "store"],
    sitem: ["new", "store"],
    sprq: ["PRQ-2026-013", "store"],
    stkt: ["TKT-0440", "store"],
    sup: ["SUP-0043", "counter"],
  };
  for (const key of Object.keys(DRAWERS)) {
    it(key, () => {
      const over = OPEN_OVER[key];
      expect(over, `no id/role in OPEN_OVER for the registered drawer "${key}"`).toBeTruthy();
      const [id, role] = over;
      act(() => { as(role); });
      expect(render(createElement(DRAWERS[key], { id })).length).toBeGreaterThan(200);
    });
  }

  // A second purchase order through the same key: PO-2026-0141 is part-received where
  // PO-2026-0140 is still a draft, and the drawer draws a different half of itself for each.
  it("bpo over a part-received order", () => {
    act(() => { as("buyer"); });
    expect(render(createElement(DRAWERS.bpo, { id: "PO-2026-0141" })).length).toBeGreaterThan(200);
  });

  // Not a row in `cases` above: the kitchen's ticket window opens on a ticket the kitchen
  // *issued*, and the fixtures seed exactly one ticket, store -> coffee. So the row is set up
  // here instead. What it pins is the whole reason the drawer exists: before it, every kitchen
  // handover went through `handover(id)` with no OTP, which the server records as a supervisor
  // override - the kitchen had a button but nowhere to type what the collector read out.
  it("ptkt gives the kitchen a box for the collector's OTP, and an override behind its own label", () => {
    act(() => {
      as("prod");
      useApp.setState({ tkt: [{
        id: "TKT-0905", req: "PRD-2026-029", from: "kitchen", to: "kiosk",
        lines: [{ it: "puff", qty: 12 }], st: "Issued", otp: "",
        hist: [{ s: "Issued", who: "Vinoth Prakash", t: "10:12", iso: "2026-09-04T04:42:00.000Z" }],
      }] });
    });
    const html = render(createElement(DRAWERS.ptkt, { id: "TKT-0905" }));
    expect(html).toContain("otp-in");
    expect(html).toContain("OTP quoted by the collector");
    expect(html).toContain("Hand over on OTP");
    expect(html).toContain("Hand over without the OTP (supervisor override)");
    // The kitchen is the issuing side, so it is told whose screen the digits are on rather than
    // shown six blanks it could read out to itself.
    expect(html).toContain("Ask Snack Kiosk to read out the six digits");
    expect(html).not.toContain("otp-v");
  });

  // Not a row in `cases` above: PO-2026-0142 (milk, butter - neither has a printed MRP)
  // shares the "bgrn" key with PO-2026-0141 (juice, water - both have one), and the shared
  // loop titles each case by `key` alone, so a second "bgrn" row there would collide on
  // test title. Rendered directly instead, pinning both arms of the "Not printed" branch.
  it("bgrn shows 'Not printed' only for lines with no printed MRP", () => {
    act(() => { as("buyer"); });
    const C = DRAWERS.bgrn;
    const withMrp = render(createElement(C, { id: "PO-2026-0141" }));
    const withoutMrp = render(createElement(C, { id: "PO-2026-0142" }));
    expect(withoutMrp).toContain("Not printed");
    expect(withMrp).not.toContain("Not printed");
  });

  // Not a row in `cases` above: id "new" opens the empty create-vendor form,
  // which shares the "bven" key with VN-001's edit form and would collide on
  // the shared loop's test title. Rendered directly instead, to pin the
  // create-mode branch - no vendor loaded, so no Deactivate/Reactivate
  // footer control - that VN-001's row never exercises.
  it("bven shows an empty create form for a new vendor, with no deactivate control", () => {
    act(() => { as("buyer"); });
    const html = render(createElement(DRAWERS.bven, { id: "new" }));
    expect(html).toContain("Add vendor");
    expect(html).not.toContain("Deactivate");
    expect(html).not.toContain("Reactivate");
  });

  // Not a row in `cases` above: id "milk" opens Configure for an ingredient that is
  // not on the Coffee Shop's own menu, which shares the "cconfig" key with "juice"
  // (a sellable product) and would collide on the shared loop's test title.
  it("cconfig shows a note instead of a switch for a non-sellable ingredient", () => {
    act(() => { as("counter"); });
    const notSellable = render(createElement(DRAWERS.cconfig, { id: "milk" }));
    const sellable = render(createElement(DRAWERS.cconfig, { id: "juice" }));
    expect(notSellable).toContain("nothing to switch on or off");
    expect(notSellable).not.toContain("Available at");
    expect(sellable).toContain("Available at");
  });

  // C1: an approved request the store never issued a ticket against is no longer a dead end.
  // REQ-2026-0910 is Manager approved with no ticket, REQ-2026-0909 is already Ticket issued -
  // both fixture rows, not injected, since the raiser's own drawer draws its button straight
  // off REQUEST_TRANSITIONS and needed nothing else changed to pick up the widened table.
  it("creq offers Cancel request live for an approval still awaiting a ticket, disabled once one is issued", () => {
    act(() => { as("counter"); });
    const cancelBtn = (html: string) => html.match(/<button[^>]*>Cancel request<\/button>/)?.[0];
    const awaitingTicket = render(createElement(DRAWERS.creq, { id: "REQ-2026-0910" }));
    const ticketed = render(createElement(DRAWERS.creq, { id: "REQ-2026-0909" }));
    expect(cancelBtn(awaitingTicket)).toBeDefined();
    expect(cancelBtn(awaitingTicket)).not.toContain("disabled");
    expect(cancelBtn(ticketed)).toBeDefined();
    expect(cancelBtn(ticketed)).toContain("disabled");
  });

  // C1's other new door: the manager who made the approval can withdraw it themselves, right
  // up until the store turns it into a ticket.
  it("mreq offers Withdraw approval for a decision still awaiting a ticket, and not once one is issued", () => {
    act(() => { as("manager"); });
    const awaitingTicket = render(createElement(DRAWERS.mreq, { id: "REQ-2026-0910" }));
    const ticketed = render(createElement(DRAWERS.mreq, { id: "REQ-2026-0909" }));
    expect(awaitingTicket).toContain("Withdraw approval");
    expect(ticketed).not.toContain("Withdraw approval");
  });
});

// ---- bill void ----
/**
 * The manager's own bill list, and the one button on it. What the server decides is voidable is
 * re-decided in `pos.test.ts`; what these pin is that the screen offers the door to the one role
 * that has it, on the one day it is open, and badges a bill somebody has already taken back.
 */
describe("the manager's bills, and the void door", () => {
  const bill = (over: Partial<Dated<Bill>>): Dated<Bill> => ({
    no: "CF/1188", loc: "coffee", opr: "Kavitha Raman", oprCol: "#B45309", tot: 40, tax: 1.9,
    t: "09:12", iso: new Date().toISOString(), pay: "Cash", lines: [{ it: "juice", qty: 2, rate: 20 }], ...over,
  });
  const list = (bills: Dated<Bill>[]) => {
    act(() => { as("manager"); useApp.setState({ bills }); });
    return render(createElement(manager.bills));
  };
  const drawer = (role: Role, b: Dated<Bill>) => {
    act(() => { as(role); useApp.setState({ bills: [b] }); });
    return render(createElement(DRAWERS.cbill, { id: b.no }));
  };

  it("lists every outlet's bills, badges the voided one and leaves it out of billed", () => {
    const html = list([
      bill({ no: "CF/1188", loc: "coffee", tot: 40 }),
      bill({ no: "KI/0301", loc: "kiosk", tot: 60, voided: true, voidReason: "Rang up twice" }),
    ]);
    expect(html).toContain("CF/1188");
    expect(html).toContain("KI/0301");            // a voided bill stays on the list
    expect(html).toContain("VOIDED");
    expect(html).toContain("Rang up twice");
    expect(html).toContain("Snack Kiosk");        // the column a counter never needs
    // ₹40 billed, not ₹100: the ₹60 was taken back.
    expect(html).toContain("Billed ₹40");
    expect(html).toContain("1 voided, ₹60 taken back");
    expect(html).not.toContain("Billed ₹100");
  });

  it("offers Void bill to the manager, on a bill from today that nobody has voided", () => {
    expect(drawer("manager", bill({}))).toContain("Void bill");
    // The counter took the bill; it is exactly the party that must not unsell its own takings.
    expect(drawer("counter", bill({}))).not.toContain("Void bill");
    // Yesterday's bill is an adjustment's job, and the button is not there to press.
    expect(drawer("manager", bill({ iso: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }))).not.toContain("Void bill");
    // A row with no instant cannot be told to be today's, so it offers nothing rather than guess.
    expect(drawer("manager", bill({ iso: undefined }))).not.toContain("Void bill");
  });

  it("leaves a voided bill out of the manager dashboard's outlet takings, and marks it on the feed", () => {
    act(() => {
      as("manager");
      useApp.setState({ bills: [
        bill({ no: "CF/2001", loc: "coffee", tot: 1234 }),
        bill({ no: "CF/2002", loc: "coffee", tot: 5000, voided: true, voidReason: "Rang up twice" }),
      ] });
    });
    const html = render(createElement(manager.dash));
    // ₹1,234 of takings at the Coffee Shop, not ₹6,234: the ₹5,000 was taken back.
    expect(html).toContain("₹1,234");
    expect(html).not.toContain("₹6,234");
    // The feed is what happened, so the voided bill is still on it - saying so, because the
    // amount beside it would otherwise read as money the hospital kept.
    expect(html).toContain("CF/2002");
    expect(html).toContain("VOIDED");
  });

  it("leaves a voided bill out of the movers report's sold quantity", () => {
    act(() => {
      as("store");
      useApp.setState({ bills: [
        bill({ no: "CF/2003", loc: "coffee", lines: [{ it: "juice", qty: 2, rate: 20 }] }),
        bill({ no: "CF/2004", loc: "coffee", lines: [{ it: "juice", qty: 100, rate: 20 }], voided: true, voidReason: "Wrong item" }),
      ] });
    });
    // Built rather than rendered: "Sold at outlets" is one cell of one row, and the arithmetic
    // is the whole point. `movers` measures issues by what actually left the store, and a
    // voided bill's lines never left the counter either.
    const rep = REPORTS.find((r) => r.k === "movers")!.build(useApp.getState(), { st: "loading" });
    const row = rep.rows.find((c) => c[1] === FXIT.juice.c)!;
    expect(row).toBeTruthy();
    expect(row[4]).toBe("2");
  });

  it("says what happened on a bill already voided, instead of offering the door again", () => {
    const html = drawer("manager", bill({ voided: true, voidReason: "Wrong tender - customer paid cash" }));
    expect(html).toContain("This bill was voided");
    expect(html).toContain("Wrong tender - customer paid cash");
    expect(html).not.toContain("Void bill");
    // And the tender's own status word is gone: a bill that was taken back is not "Paid".
    expect(html).not.toContain(">Paid<");
  });
});

describe("sign-in", () => {
  it("asks for an employee and a password", () => {
    act(() => { useApp.setState({ user: null, auth: "signed-out" }); });
    const html = render(createElement(Login));
    expect(html).toContain("Employee");
    expect(html).toContain("Password");
    for (const u of USERS) expect(html).not.toContain(u.n);
  });
});

describe("procurement list", () => {
  it("renders the pooled lines, grouped by item, with a source breakdown", () => {
    act(() => { as("buyer"); });
    const html = render(createElement(buyer.pool));
    expect(html).toContain("Procurement list");
    expect(html).toMatch(/Maida/);
    // The seeded pool: maida 20 from PRQ-2026-014, milk 25 from PRQ-2026-011 -
    // both must show up as their own source chip.
    expect(html).toContain("PRQ-2026-014");
    expect(html).toContain("PRQ-2026-011");
  });

  it("folds several requisitions for the same item into one pooled group", () => {
    // A flat list of raw pool lines would list milk twice; the screen's job
    // is to read it as one row with two sources, so this pins the merge
    // logic directly rather than through rendered HTML.
    const pool: PoolLine[] = [
      { prq: "PRQ-2026-011", line: 0, it: "milk", asked: 25, pending: 25, by: "Suresh Muthu", at: "06:30" },
      { prq: "PRQ-2026-013", line: 0, it: "milk", asked: 60, pending: 60, by: "Suresh Muthu", at: "07:50" },
      { prq: "PRQ-2026-014", line: 1, it: "maida", asked: 20, pending: 20, by: "Suresh Muthu", at: "07:40" },
    ];
    const groups = groupPool(pool, seedVendors);
    expect(groups).toHaveLength(2);

    const milk = groups.find((g) => g.it === "milk")!;
    expect(milk.pending).toBe(85);
    expect(milk.sources.map((s) => s.prq)).toEqual(["PRQ-2026-011", "PRQ-2026-013"]);
    expect(milk.vendor?.n).toBe("Aavin Dairy Depot");

    const maida = groups.find((g) => g.it === "maida")!;
    expect(maida.sources).toHaveLength(1);
    expect(maida.vendor?.n).toBe("Anandha Provisions");
  });

  it("splits a picked quantity across a group's sources, capped by what each still has pending", () => {
    const g: PoolGroup = {
      it: "milk",
      pending: 85,
      vendor: null,
      sources: [
        { prq: "PRQ-2026-011", line: 0, it: "milk", asked: 25, pending: 25, by: "Suresh Muthu", at: "06:30" },
        { prq: "PRQ-2026-013", line: 0, it: "milk", asked: 60, pending: 60, by: "Suresh Muthu", at: "07:50" },
      ],
    };
    // Taking less than the first source covers stays on that source alone -
    // this is the "take part now, the rest on a second pass" split.
    expect(picksFor(g, 10)).toEqual([{ prq: "PRQ-2026-011", line: 0, qty: 10 }]);
    // Spilling past the first source's pending draws the remainder from the next.
    expect(picksFor(g, 40)).toEqual([
      { prq: "PRQ-2026-011", line: 0, qty: 25 },
      { prq: "PRQ-2026-013", line: 0, qty: 15 },
    ]);
    // Never over-allocates past the group's total pending.
    expect(picksFor(g, 999)).toEqual([
      { prq: "PRQ-2026-011", line: 0, qty: 25 },
      { prq: "PRQ-2026-013", line: 0, qty: 60 },
    ]);
    expect(picksFor(g, 0)).toEqual([]);
  });
});

describe("the kitchen order board", () => {
  it("names the ticket the outlet will actually collect against (I1)", () => {
    // An order withdrawn off its ticket goes back to Ready and can be dispatched again, so it
    // ends the day carrying two - and the server hands them over oldest first. The card used
    // to print the first one it found, which is the withdrawn one.
    act(() => {
      as("prod");
      useApp.setState({
        pord: [{ id: "PRD-2026-029", from: "kiosk", by: "Ramesh Kumar", at: "07:10", iso: "2026-09-04T01:40:00.000Z",
          lines: [{ it: "puff", qty: 40 }], st: "Dispatched", note: "",
          hist: [{ s: "Raised", who: "Ramesh Kumar", t: "07:10", iso: "2026-09-04T01:40:00.000Z" }] }],
        tkt: [
          { id: "TKT-0801", req: "PRD-2026-029", from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: 40 }], st: "Cancelled", otp: "", hist: [] },
          { id: "TKT-0802", req: "PRD-2026-029", from: "kitchen", to: "kiosk", lines: [{ it: "puff", qty: 40 }], st: "Issued", otp: "", hist: [] },
        ],
      });
    });
    const html = render(createElement(prod.orders));
    expect(html).toContain("TKT-0802");
    expect(html).not.toContain("TKT-0801");
  });
});

/**
 * Where the six digits are drawn, and where they are not. The server sends a ticket's OTP to the
 * ticket's destination and to nobody else (`redactOtps`), so "which side am I on" is the only
 * question a screen may ask before rendering the panel - and it is the question both of these
 * screens used to get wrong in opposite directions.
 */
describe("the collection OTP reaches the collector's screen and no other", () => {
  const tkt = (over: Partial<Trailed<Ticket>>): Trailed<Ticket> => ({
    id: "TKT-0900", req: "PRD-2026-029", from: "store", to: "kitchen",
    lines: [{ it: "milk", qty: 6 }], st: "Issued", otp: "246810", hist: [], ...over,
  });

  it("shows the kitchen the digits on a ticket coming in to it", () => {
    act(() => {
      as("prod");
      useApp.setState({ tkt: [tkt({ id: "TKT-0901" })] });
    });
    const html = render(createElement(prod.tickets));
    expect(html).toContain("otp-v");            // the panel is drawn
    expect(html).toContain("246 810");   // the panel spaces the two triples
  });

  it("never draws it on a ticket the kitchen issued out - the server sends it none", () => {
    act(() => {
      as("prod");
      // `otp: ""` is what the kitchen actually receives for its own outbound ticket; the row
      // must say who holds the digits rather than render six blanks.
      useApp.setState({ tkt: [tkt({ id: "TKT-0902", from: "kitchen", to: "kiosk", otp: "" })] });
    });
    const html = render(createElement(prod.tickets));
    expect(html).not.toContain("otp-v");
    expect(html).toContain("Held by Snack Kiosk");
  });

  it("says the digits were used once an inbound ticket has moved on", () => {
    act(() => {
      as("prod");
      useApp.setState({ tkt: [tkt({ id: "TKT-0903", st: "Received", otp: "" })] });
    });
    const html = render(createElement(prod.tickets));
    expect(html).not.toContain("otp-v");
    expect(html).toContain("used at handover");
  });

  it("says the digits were never used on an inbound ticket somebody withdrew", () => {
    // A cancelled ticket comes back with `otp: ""` like a received one, and the empty cell used
    // to read "used at handover" for both - which is a lie about a ticket nobody collected.
    act(() => {
      as("prod");
      useApp.setState({ tkt: [tkt({ id: "TKT-0904", st: "Cancelled", otp: "" })] });
    });
    const html = render(createElement(prod.tickets));
    expect(html).not.toContain("otp-v");
    expect(html).toContain("withdrawn - the OTP was never used");
    expect(html).not.toContain("used at handover");
  });
});

/** The counter's own ticket drawer opens on both directions, and almost every sentence on it
 *  turns on which one - including whether a receipt may be confirmed at all. */
describe("the counter's ticket drawer reads its own direction", () => {
  const open = (t: Trailed<Ticket>) => {
    act(() => { as("counter"); useApp.setState({ tkt: [t] }); });
    return render(createElement(DRAWERS.ctkt, { id: t.id }));
  };
  const inbound = (over: Partial<Trailed<Ticket>> = {}): Trailed<Ticket> => ({
    id: "TKT-0910", req: "REQ-2026-0909", from: "store", to: "coffee",
    lines: [{ it: "milk", qty: 6 }], st: "Issued", otp: "135791", hist: [], ...over,
  });
  const sent = (over: Partial<Trailed<Ticket>> = {}): Trailed<Ticket> =>
    inbound({ id: "TKT-0911", from: "coffee", to: "kiosk", req: "Shop transfer", otp: "", ...over });

  it("tells the collector to read the digits out, on a ticket it is waiting to collect", () => {
    const html = open(inbound());
    expect(html).toContain("135 791");
    expect(html).toContain("reads these six digits aloud to the store keeper at Central Store");
  });

  it("tells the granting counter whose screen the digits are on, on a ticket it sent", () => {
    const html = open(sent());
    expect(html).not.toContain("otp-v");
    expect(html).toContain("The six digits sit on Snack Kiosk");
    expect(html).not.toContain("reads these six digits aloud");
  });

  it("says the digits are spent once an inbound ticket has been collected", () => {
    const html = open(inbound({ st: "Collected", otp: "" }));
    expect(html).toContain("were used at handover");
    // and not the sentence for a ticket this counter raised, which it did not
    expect(html).not.toContain("this ticket was raised here");
  });

  it("says the digits were never used on an inbound ticket somebody withdrew", () => {
    // Withdrawn and collected both arrive with `otp: ""`, and only the status separates them.
    // Telling a counter its digits "were used at handover" on a ticket nobody ever collected
    // would have it looking for goods that never left the store.
    const html = open(inbound({ st: "Cancelled", otp: "" }));
    expect(html).toContain("withdrawn before anyone collected against it");
    expect(html).not.toContain("otp-v");
    expect(html).not.toContain("were used at handover");
  });

  it("offers Confirm receipt only on a ticket addressed to this counter", () => {
    // The server refuses a receipt from anywhere but the ticket's destination
    // (`requireLocOf(claims, t.to)`), so the button must not be there to press.
    expect(open(inbound({ st: "Collected", otp: "" }))).toContain("Confirm receipt");
    expect(open(sent({ st: "Collected" }))).not.toContain("Confirm receipt");
  });

  it("offers the withdraw door only on a ticket this counter sent, and nobody has collected", () => {
    expect(open(sent())).toContain("Withdraw this ticket");
    expect(open(sent({ st: "Collected" }))).not.toContain("Withdraw this ticket");
    expect(open(inbound())).not.toContain("Withdraw this ticket");
  });
});

// ---- item patch ----
/**
 * One drawer, four desks. `ITEM_FIELD_ROLES` (`@rch/domain`) is the same table the server
 * refuses a patch with, so a box this greys out is exactly one the server would turn away -
 * which is the whole point of driving the form off the rule rather than off a second list.
 */
describe("the item drawer is the same table the server refuses with", () => {
  const open = (role: Role, id = "juice") => {
    act(() => { as(role); });
    return render(createElement(DRAWERS.item, { id }));
  };

  it("tells the manager the operational fields are somebody else's", () => {
    const html = open("manager");
    expect(html).toContain("Edit Real Juice 200ml");
    expect(html).toContain("The name, the group, the HSN code, the reorder level and the shelf life belong to the store, the buyer and the kitchen");
  });

  it("tells the store, the buyer and the kitchen the commercial figures are the manager's", () => {
    for (const role of ["store", "buyer", "prod"] as Role[]) {
      expect(open(role)).toContain("The printed MRP, the standard cost and the GST rate belong to the outlet manager");
    }
  });

  it("greys the shelf-life box for the manager and opens it for the store, the buyer and the kitchen", () => {
    expect(open("manager")).toContain("The store, the buyer or the kitchen sets the shelf life.");
    for (const role of ["store", "buyer", "prod"] as Role[]) {
      expect(open(role)).toContain("Blank or 0 if it does not carry a best-before.");
    }
  });

  it("offers Retire on a live line and Restore on a retired one", () => {
    expect(open("store")).toContain("Retire this product");
    act(() => { IT.chips = { ...IT.chips, active: false }; });
    const retired = render(createElement(DRAWERS.item, { id: "chips" }));
    expect(retired).toContain("Restore to the catalogue");
    expect(retired).toContain("is off the catalogue");
    expect(retired).not.toContain("Retire this product");
  });

  it("says so rather than throwing when the item has left the master under it", () => {
    expect(open("store", "nosuchitem")).toContain("Item not found");
  });

  it("will not offer to clear a printed MRP - the box says leaving it alone changes nothing", () => {
    // There is no clearing door: the server refuses `mrp: 0` outright, so the drawer must not
    // read an emptied box as a request to remove the ceiling.
    const html = open("manager");
    expect(html).toContain("Leave the box as it is to keep the current ceiling; emptying it changes nothing");
  });
});

// ---- item patch ----
/** A retired line stays in `IT` so past documents still name it. Every screen that reads the
 *  registry as "what we buy / hold / reorder" has to filter it out, or the product the hospital
 *  deliberately stopped carrying goes on generating work. */
describe("a retired product stops generating work", () => {
  const retire = (k: string) => act(() => { IT[k] = { ...IT[k], active: false }; });

  it("drops out of the buyer's below-reorder count", () => {
    // Milk is the seeded line that is below its reorder level at the central store: 12 L on
    // hand against a level of 40.
    act(() => { as("buyer"); });
    const counts = (html: string) => html.match(/(\d+) of (\d+) below reorder/)!.slice(1).map(Number);
    const [belowBefore, boughtBefore] = counts(render(createElement(buyer.dash)));
    expect(belowBefore).toBeGreaterThan(0);

    retire("milk");
    const [belowAfter, boughtAfter] = counts(render(createElement(buyer.dash)));
    expect(belowAfter).toBe(belowBefore - 1);
    expect(boughtAfter).toBe(boughtBefore - 1);
  });

  it("is never offered to a requisition, and reads greyed on the shelf it is still standing on", () => {
    act(() => { as("store"); });
    // The row for milk, on its own: `DataTable` gives every row the item key as its React key,
    // which reaches the DOM as nothing, so the row is found by the item's own code instead.
    const rowOf = (html: string, code: string) =>
      html.split("<tr").find((chunk) => chunk.includes(code)) ?? "";

    const before = rowOf(render(createElement(store.stock)), "RM-1001");
    expect(before).toContain("Add to requisition");
    expect(before).not.toContain("Retired");

    retire("milk");
    const after = rowOf(render(createElement(store.stock)), "RM-1001");
    // Still listed - twelve litres are on the shelf and somebody has to write them off - but
    // nothing on the row asks for more of it.
    expect(after).toContain("Retired");
    expect(after).not.toContain("Add to requisition");
    expect(after).toContain("Restore");
  });

  it("comes off the kitchen's makeable list", () => {
    // `madeItems()` is "every FG with a recipe", read by all three kitchen screens. A retired
    // one still has both, so it kept its Make tile - and `POST /batches` reads `loadItems`,
    // which does filter `active`, so the tile could only ever answer "There is no item puff."
    expect(madeItems()).toContain("puff");
    retire("puff");
    expect(madeItems()).not.toContain("puff");

    act(() => { as("prod"); });
    expect(render(createElement(prod.make))).not.toContain("Quantity of Veg puffs to start");
  });

  it("is not offered as a fresh line on the write-off form, though a shelf still holding it is", () => {
    act(() => { as("store"); });
    /** The item picker on a fresh write-off line at the central store, which is the shelf the
     *  form opens on. It is drawn per line, so a line has to be added before there is one. */
    const offered = () => {
      const ui = mount(store.adjust);
      act(() => { ui.button("Add line").click(); });
      const keys = [...ui.host.querySelector<HTMLSelectElement>('select[aria-label="Item on line 1"]')!.options]
        .map((o) => o.value);
      ui.unmount();
      return keys;
    };

    // Two halves of one rule, and the fixtures give one of each at the central store: `puff` is
    // not on that shelf, `chips` is (88 packets).
    expect(offered()).toContain("puff");
    retire("puff");
    retire("chips");
    const after = offered();
    // Correcting a shelf for a product the hospital stopped carrying, and that this location
    // never held, is work nobody can do.
    expect(after).not.toContain("puff");
    // But the packets on the shelf are real, and writing them off is how the retirement finishes.
    expect(after).toContain("chips");
  });
});

// ---- prod-order raise ----
describe("the counter can ask the kitchen, and only for what the kitchen makes", () => {
  it("offers the finished goods on that outlet's menu and nothing else", () => {
    // Through the manager's drawer, whose outlet picker opens on OUTLETS[0] - the Restaurant,
    // the one shop with finished goods on its menu and the only way to reach one from a test
    // (the fixtures' two counters are the Coffee Shop and the Snack Kiosk).
    act(() => { as("manager"); });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(MemoryRouter, null, createElement(DRAWERS.korder, { id: "new" }))); });

    const options = [...host.querySelectorAll("select[aria-label='Product 1'] option")].map((o) => o.textContent);
    // The Restaurant's menu is capp, chai, puff, sand, salad, juice, water, chips. Only the
    // three finished goods may be ordered: the four bought-in lines come off the central
    // store's shelf, and `capp`/`chai` are made at the till the moment they are sold - nothing
    // downstream could fill an order for one, so the picker must not offer them.
    expect(options).toEqual(["Garden salad", "Veg puffs", "Veg sandwich"]);

    act(() => { root.unmount(); });
    host.remove();
  });

  it("says so honestly when a menu has nothing the kitchen makes, and offers no Send", () => {
    act(() => { as("counter"); });                       // Kavitha, Coffee Shop
    // The form only exists once the card's own action tile is pressed, so this renders into a
    // host it keeps mounted rather than going through `render` above, which unmounts to return.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(MemoryRouter, null, createElement(counter.requests))); });
    expect(host.innerHTML).toContain("Ask the kitchen");

    const tile = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("From the kitchen"))!;
    act(() => { tile.click(); });
    // The Coffee Shop sells capp, chai, juice, water, bisc, chips - two made at the till and
    // four bought in, and not one finished good. There is nothing to order, so the card says
    // that rather than offering an empty picker and a button the server would refuse.
    expect(host.innerHTML).toContain("Nothing on this menu is made in the kitchen");
    expect(host.querySelector("select[aria-label='Product 1']")).toBeNull();
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Send to the kitchen");

    act(() => { root.unmount(); });
    host.remove();
  });

  it("prints a needed-by date on the kitchen's board only when the outlet gave one", () => {
    act(() => {
      as("prod");
      useApp.setState({
        pord: [
          { id: "PRD-2026-031", from: "kiosk", by: "Deepa Selvam", at: "07:10", iso: "2026-09-04T01:40:00.000Z",
            lines: [{ it: "puff", qty: 40 }], st: "New", note: "", need: "2026-09-11",
            hist: [{ s: "Raised", who: "Deepa Selvam", t: "07:10", iso: "2026-09-04T01:40:00.000Z" }] },
          { id: "PRD-2026-032", from: "kiosk", by: "Deepa Selvam", at: "07:20", iso: "2026-09-04T01:50:00.000Z",
            lines: [{ it: "puff", qty: 10 }], st: "New", note: "",
            hist: [{ s: "Raised", who: "Deepa Selvam", t: "07:20", iso: "2026-09-04T01:50:00.000Z" }] },
        ],
      });
    });
    const html = render(createElement(prod.orders));
    expect(html).toContain("needed by 11-Sep-2026");
    expect(html.match(/needed by/g)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------
 * The three forms whose screens had not caught up with an action that
 * answers whether the server took the write: the settings password card,
 * which called nothing at all, and the two that cleared what was typed
 * whatever came back.
 * ---------------------------------------------------------------------- */

/** Hosts that stay mounted for the length of a case, so a form can be typed into and pressed. */
const mounted: { unmount: () => void }[] = [];
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); });

function mount(C: ComponentType) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, createElement(C))); });
  const ui = {
    host,
    text: () => host.textContent ?? "",
    button: (label: string) =>
      [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label))!,
    /** `Field` ties its label to the control it wraps by id, which is how an operator finds one. */
    field: (label: string) => {
      const l = [...host.querySelectorAll("label")].find((x) => (x.textContent ?? "").trim() === label)!;
      return host.querySelector<HTMLInputElement>(`#${l.htmlFor}`)!;
    },
    labelled: (aria: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${aria}"]`)!,
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
  mounted.push(ui);
  return ui;
}
/** Typing, the way React hears it. */
const typeIn = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const settle = async (fn: () => void) => {
  await act(async () => { fn(); await new Promise((r) => { setTimeout(r, 0); }); });
};

describe("the settings sign-in card", () => {
  it("calls changePassword with the typed values", async () => {
    const changePassword = vi.fn(async () => true);
    act(() => { as("counter"); useApp.setState({ changePassword }); });
    const ui = mount(Settings);

    typeIn(ui.field("Current password"), "old-one-please");
    typeIn(ui.field("New password"), "a-brand-new-password");
    typeIn(ui.field("Confirm new password"), "a-brand-new-password");
    await settle(() => { ui.button("Update password").click(); });

    expect(changePassword).toHaveBeenCalledWith("old-one-please", "a-brand-new-password");
    // Taken by the server, so the three boxes are empty again.
    expect(ui.field("Current password").value).toBe("");
    expect(ui.field("New password").value).toBe("");
  });

  it("invents no counter PIN and lets nobody retype their own employee id", () => {
    act(() => { as("counter"); });
    const ui = mount(Settings);
    expect(ui.text()).not.toContain("Counter PIN");
    expect(ui.field("Employee ID").readOnly).toBe(true);
  });

  it("keeps the typing when the change is refused", async () => {
    const changePassword = vi.fn(async () => false);
    act(() => {
      as("counter");
      useApp.setState({ changePassword, authError: "That is not your current password." });
    });
    const ui = mount(Settings);

    typeIn(ui.field("Current password"), "wrong-one-here");
    typeIn(ui.field("New password"), "a-brand-new-password");
    typeIn(ui.field("Confirm new password"), "a-brand-new-password");
    await settle(() => { ui.button("Update password").click(); });

    expect(ui.field("Current password").value).toBe("wrong-one-here");
    expect(ui.text()).toContain("That is not your current password.");
  });
});

describe("a form whose write the server refused", () => {
  it("a refused pay keeps the payer", async () => {
    const pay = vi.fn(async () => null);
    act(() => {
      as("counter");                                   // Kavitha, Coffee Shop
      useApp.setState({ pay, readCredit: async () => null, cart: { coffee: { juice: 1 } } });
    });
    const ui = mount(counter.pos);

    // A staff-credit bill cannot be raised without somebody to post it to.
    await settle(() => { ui.button("Staff credit").click(); });
    const picked = ui.button("RC-4471");
    const name = picked.querySelector("b")!.textContent ?? "";
    await settle(() => { picked.click(); });
    expect(ui.text()).toContain(`posted to ${name}`);

    await settle(() => { ui.button("Pay").click(); });

    expect(pay).toHaveBeenCalled();
    // Refused: the operator must not have to find the same staff member again.
    expect(ui.text()).toContain(`posted to ${name}`);
  });

  it("a refused price save keeps the typed value", async () => {
    const savePrice = vi.fn(async () => false);
    act(() => { as("manager"); useApp.setState({ savePrice, shopFilter: "coffee" }); });
    const ui = mount(manager.prices);

    const box = ui.labelled("New price for Real Juice 200ml");
    typeIn(box, "37");
    const save = [...box.closest("tr")!.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    await settle(() => { save.click(); });

    expect(savePrice).toHaveBeenCalledWith("B", "juice", 37);
    expect(ui.labelled("New price for Real Juice 200ml").value).toBe("37");
  });
});

/* ------------------------------------------------------------------------
 * "Pay & print" and "Reprint" printed nothing: there was no `window.print()`
 * anywhere in the app, and no paper for one to put on a printer. The slip is
 * the `.print-slip` block at the end of `styles.css` - everything else on the
 * page is hidden while it prints.
 * ---------------------------------------------------------------------- */
describe("what actually reaches the printer", () => {
  // 11 Sep 2026, 23:30 at the hospital - and still the 11th in UTC only by five and a half
  // hours' grace: 18:00Z is 23:30 IST, so a slip that converted with the host's day would print
  // the 11th here and the 10th for anything a minute later. `vite.config.ts` pins TZ=UTC, so a
  // date read straight off the instant's UTC day gets the evening shift wrong every night.
  const LATE_IST = "2026-09-11T18:30:00.000Z";      // 12 Sep 00:00 IST - the far side of midnight
  const BILL: Dated<Bill> = {
    no: "CF/1188", loc: "coffee", opr: "Kavitha Raman", oprCol: "#B45309", tot: 40, tax: 4.29,
    t: "00:00", iso: LATE_IST, pay: "Cash",
    lines: [{ it: "juice", qty: 2, rate: 20 }],
  };

  it("puts the bill on paper and sends it to the printer on Reprint", () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    act(() => { as("counter"); useApp.setState({ bills: [BILL] }); });
    const ui = mount(() => createElement(DRAWERS.cbill, { id: "CF/1188" }));

    const slip = ui.host.querySelector(".print-slip")!;
    expect(slip).toBeTruthy();
    const paper = slip.textContent ?? "";
    expect(paper).toContain("CF/1188");            // bill number
    expect(paper).toContain("Coffee Shop");        // outlet
    expect(paper).toContain("00:00");              // the time
    // The hospital's day, spelled as every other date on screen is. `fromWireDate` is `dmy`,
    // which only parses "YYYY-MM-DD" and hands a full instant straight back, so this read
    // "2026-09-11T18:30:00.000Z"; and 18:30Z is already the 12th in Asia/Kolkata, so a slip
    // built off the host's UTC day would print the 11th under a midnight bill.
    expect(paper).toContain("12-Sep-2026");
    expect(paper).not.toContain("2026-09-11T");
    expect(paper).toContain("Real Juice 200ml");   // the line
    expect(paper).toContain("₹20.00");             // its rate
    expect(paper).toContain("₹40.00");             // the total
    expect(paper).toContain("₹4.29");              // the tax
    expect(paper).toContain("Cash");               // the tender

    act(() => { ui.button("Reprint").click(); });
    expect(print).toHaveBeenCalled();
    print.mockRestore();
  });

  it("names the payer on paper when the bill was posted to somebody", () => {
    act(() => {
      as("counter");
      useApp.setState({ bills: [{ ...BILL, pay: "Staff credit", payer: { kind: "staff", id: "RC-3120", name: "Ramesh Kumar · F&B" } }] });
    });
    const ui = mount(() => createElement(DRAWERS.cbill, { id: "CF/1188" }));
    expect(ui.host.querySelector(".print-slip")!.textContent).toContain("Ramesh Kumar · F&B");
  });

  it("opens the new bill's drawer once the server has numbered it", async () => {
    act(() => {
      as("counter");
      useApp.setState({
        cart: { coffee: { juice: 1 } },
        bills: [{ ...BILL, no: "CF/1100", iso: "2026-09-11T02:00:00.000Z" }],
        // A bill the server took, with the read-back behind it landing too.
        pay: async () => {
          useApp.setState({ bills: [{ ...BILL, no: "CF/1189", iso: "2026-09-11T04:00:00.000Z" }, { ...BILL, no: "CF/1100", iso: "2026-09-11T02:00:00.000Z" }] });
          return "CF/1189";
        },
      });
    });
    const ui = mount(counter.pos);
    await settle(() => { ui.button("Pay").click(); });
    expect(useApp.getState().drawer).toEqual({ t: "cbill", id: "CF/1189" });
  });

  // The number is the write's own answer, not a guess off the refetched list. The guess was
  // "the newest bill at this outlet by `iso`", which is the *previous* customer's slip whenever
  // the read-back behind the sale fails - the sale is on the server, the list is not, and the
  // till prints somebody else's bill.
  it("opens the bill the server numbered even when the read-back behind it failed", async () => {
    act(() => {
      as("counter");
      useApp.setState({
        cart: { coffee: { juice: 1 } },
        bills: [{ ...BILL, no: "CF/1100", iso: "2026-09-11T02:00:00.000Z" }],
        pay: async () => "CF/1189",     // taken and numbered; the list never moved
      });
    });
    const ui = mount(counter.pos);
    await settle(() => { ui.button("Pay").click(); });
    expect(useApp.getState().drawer).toEqual({ t: "cbill", id: "CF/1189" });
  });

  it("prints a counter's ticket, with the six digits only where this browser holds them", () => {
    const t = (otp: string): Trailed<Ticket> => ({
      id: "TKT-2026-0442", req: "REQ-2026-0910", from: "store", to: "coffee", st: "Issued", otp,
      lines: [{ it: "juice", qty: 24 }],
      hist: [{ s: "Issued", who: "Murugan S", t: "09:40", iso: "2026-09-11T04:10:00.000Z" }],
    });

    act(() => { as("counter"); useApp.setState({ tkt: [t("481203")] }); });
    const held = mount(() => createElement(DRAWERS.ctkt, { id: "TKT-2026-0442" }));
    const paper = held.host.querySelector(".print-slip")!.textContent ?? "";
    expect(paper).toContain("TKT-2026-0442");
    expect(paper).toContain("Central Store");
    expect(paper).toContain("Coffee Shop");
    expect(paper).toContain("Real Juice 200ml");
    expect(paper).toContain("481203");
    expect(held.button("Print slip")).toBeDefined();

    // The server redacts the code for everyone but the collector, so a blank one is not a
    // fault - and the paper must not carry an empty box that reads like one.
    act(() => { useApp.setState({ tkt: [t("")] }); });
    const blind = mount(() => createElement(DRAWERS.ctkt, { id: "TKT-2026-0442" }));
    const blank = blind.host.querySelector(".print-slip")!.textContent ?? "";
    expect(blank).toContain("TKT-2026-0442");
    expect(blank).not.toContain("481203");
    expect(blank).toContain("the collector reads the code out");
  });
});

/* ------------------------------------------------------------------------
 * The manager's approval drawer: a box a half-litre could not be typed into,
 * and derived state that stayed on the request it was first opened over.
 * ---------------------------------------------------------------------- */
describe("the approval drawer", () => {
  const req = (over: Partial<DatedDoc<StockRequest>>): DatedDoc<StockRequest> => ({
    id: "REQ-2026-0951", from: "coffee", by: "Kavitha Raman", at: "09:40",
    iso: "2026-09-11T04:10:00.000Z", st: "Request sent", urg: false, mgrNote: "", ticket: null,
    lines: [{ it: "milk", qty: 20, appr: 0 }],
    hist: [{ s: "Request sent", who: "Kavitha Raman", t: "09:40", iso: "2026-09-11T04:10:00.000Z" }],
    ...over,
  });
  const box = (ui: ReturnType<typeof mount>) => ui.labelled("Approved quantity for Milk 1L (toned)");

  it("takes a decimal quantity without eating the point", () => {
    act(() => { as("manager"); useApp.setState({ req: [req({})] }); });
    const ui = mount(() => createElement(DRAWERS.mreq, { id: "REQ-2026-0951" }));

    // Reading the box on every keystroke turned "12.5" into 1, then 12, then 125 clamped
    // back to the line's own 20 - the trailing point was never a number, so it was dropped.
    act(() => { typeIn(box(ui), "12.5"); });
    expect(box(ui).value).toBe("12.5");
    act(() => { box(ui).dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(box(ui).value).toBe("12.5");
    // `unitTotal`'s own three decimals - the point survived, which is the whole case.
    expect(ui.text()).toContain("12.500 L");
  });

  it("re-derives what it is approving when the drawer is pointed at another request", () => {
    act(() => {
      as("manager");
      useApp.setState({
        req: [req({}), req({ id: "REQ-2026-0952", lines: [{ it: "milk", qty: 3, appr: 0 }] })],
      });
    });
    // The same component instance, pointed at a second request - which is exactly what
    // `openDrawer("mreq", other)` does while one is already open.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const show = (id: string) => {
      act(() => { root.render(createElement(MemoryRouter, null, createElement(DRAWERS.mreq, { id }))); });
    };
    show("REQ-2026-0951");
    const read = () => host.querySelector<HTMLInputElement>('input[aria-label="Approved quantity for Milk 1L (toned)"]')!.value;
    const first = read();
    show("REQ-2026-0952");
    // Whatever the store can promise, the second request only asked for 3 - the box must not
    // still be offering the first request's quantity against the second request's line.
    expect(Number(read())).toBeLessThanOrEqual(3);
    expect(read()).not.toBe(first);
    act(() => { root.unmount(); });
    host.remove();
  });

  // Everything the drawer derives - the per-line quantities, the struck-out lines, the reason
  // boxes - is a `useState` initialiser, so the key on `ApprovalBody` is the only thing that can
  // make any of it re-derive. What that key has to track is therefore the whole of this rule.
  it("keys its derived state on the trail, which moves, and not on the raise instant, which never does", async () => {
    const raised = req({});
    const decided = req({
      st: "Partially approved",
      mgrNote: "Send 4 only - the rest is promised to the Kiosk",
      lines: [{ it: "milk", qty: 20, appr: 4 }],
      hist: [
        ...raised.hist,
        { s: "Partially approved", who: "Ramesh Kumar", t: "09:52", iso: "2026-09-11T04:22:00.000Z" },
      ],
    });

    // The two are the same document either side of somebody else's decision, and their `iso`
    // is identical - it is when the *counter raised it*, which nothing ever changes. Keying on
    // that was keying on `req.id` twice, so an SSE refetch re-derived nothing.
    expect(decided.iso).toBe(raised.iso);
    expect(bodyKey(decided)).not.toBe(bodyKey(raised));
    // And it must not churn on a refetch that brought the same document back unchanged, or the
    // trim the manager is halfway through typing is thrown away every 250 ms.
    expect(bodyKey(req({}))).toBe(bodyKey(raised));

    // The rendered half: a refetch that changed nothing leaves the box, and what is typed in it,
    // exactly where they were.
    act(() => { as("manager"); useApp.setState({ req: [raised] }); });
    const ui = mount(() => createElement(DRAWERS.mreq, { id: "REQ-2026-0951" }));
    const before = box(ui);
    act(() => { typeIn(before, "9"); });
    act(() => { before.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    await act(async () => { useApp.setState({ req: [req({})] }); });
    expect(box(ui)).toBe(before);
    expect(box(ui).value).toBe("9");
  });

  it("offers one Approve and one Reject, not two of each", () => {
    act(() => { as("manager"); useApp.setState({ req: [req({})] }); });
    const ui = mount(() => createElement(DRAWERS.mreq, { id: "REQ-2026-0951" }));
    const labels = [...ui.host.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.filter((l) => l.startsWith("Approve"))).toHaveLength(1);
    expect(labels.filter((l) => l.startsWith("Reject the"))).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------
 * The counter's own request screen: what it will let an operator send, and
 * what it does on a deployment or a catalogue it was not written against.
 * ---------------------------------------------------------------------- */
describe("the counter's stock requests", () => {
  it("will not send more of a shop's ask than this counter is holding free", () => {
    act(() => {
      as("counter");                                   // Kavitha, Coffee Shop
      useApp.setState({
        // The kiosk wants 40; the Coffee Shop has eight on the shelf.
        shopAsks: [{
          id: "ASK-2026-0021", from: "kiosk", to: "coffee", it: "juice", qty: 40,
          st: "Asked", at: "09:20", iso: "2026-09-11T03:50:00.000Z", by: "Deepa Selvam", note: "",
        }],
      });
    });
    const ui = mount(counter.requests);
    const qty = ui.host.querySelector<HTMLInputElement>("#g-ASK-2026-0021")!;
    const send = () => [...ui.host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith("Send"))!;

    expect(send().disabled).toBe(false);
    // The box is a `DraftLineInput`, so what is typed reaches the grant on the way out of the
    // field, not on every keystroke - which is what lets 1.5 L be offered as 1.5 rather than 1.
    act(() => { typeIn(qty, "40"); });
    act(() => { qty.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    // Forty is more than the shelf holds, so the server would refuse it - the button does not
    // offer to go and find that out. The cap used to be only `g > 0`.
    expect(send().disabled).toBe(true);
  });

  it("says there is nobody to ask on a one-outlet deployment", () => {
    act(() => { as("counter"); });
    // One counter and no peer: `peers[0]` was `undefined`, and `LOC[undefined].n` took the
    // whole screen down before it could draw a single row.
    const saved = [...OUTLETS];
    OUTLETS.splice(0, OUTLETS.length, "coffee");
    try {
      const ui = mount(counter.requests);
      expect(ui.text()).toContain("No other outlet to ask");
      expect(ui.text()).toContain("Stock requests");     // and the rest of the screen is there
    } finally {
      OUTLETS.splice(0, OUTLETS.length, ...saved);
    }
  });

  it("moves off a product the catalogue has stopped carrying", async () => {
    act(() => { as("counter"); });
    const ui = mount(counter.requests);
    act(() => { ui.button("From inventory").click(); });
    const picked = () => ui.host.querySelector<HTMLSelectElement>('select[aria-label="Product"]')!.value;
    const first = picked();
    expect(first).toBeTruthy();

    // What an SSE resync after somebody retires an item looks like: the key the picker opened
    // on is no longer in the catalogue, and `useState(LIST[0])` was frozen on it for ever -
    // so Submit posted a line for a product the server no longer sells.
    act(() => {
      IT[first] = { ...IT[first], active: false };
      useApp.setState({ catalogVersion: useApp.getState().catalogVersion + 1 });
    });
    expect(picked()).not.toBe(first);
    expect(activeItems()).toContain(picked());

    // And the *state* moved, not only what the browser falls back to painting for a `value`
    // no option carries: what Submit posts is read off `invItem`, not off the select.
    act(() => { useApp.setState({ submitRequest: async () => false }); });
    await settle(() => { ui.button("Submit request").click(); });
    expect(useApp.getState().draft[0]?.it).toBe(picked());
  });
});

/* ------------------------------------------------------------------------
 * Fix round 1: four smaller things the review found.
 * ---------------------------------------------------------------------- */
describe("a refusal is shown where it was raised and nowhere else", () => {
  it("does not carry an earlier sign-in's refusal onto the settings password card", () => {
    // `authError` is one field shared by the two forms that write it, and it is cleared only on
    // the *next* attempt - so a failed sign-in earlier in the shift was still sitting in the
    // store when Settings opened, and the card accused the operator of a refusal it had never
    // asked for. It speaks once this form has been used, and not before.
    act(() => { as("counter"); useApp.setState({ authError: "That is not your current password." }); });
    const ui = mount(Settings);
    expect(ui.text()).not.toContain("That is not your current password.");
    expect(ui.text()).not.toContain("REFUSED");
  });

  it("reads a refusal out loud, and a notice only when it is asked for", () => {
    // A critical alert is a refusal or a block, and a screen reader has to interrupt for it;
    // every other tone is a notice that can wait its turn. Neither carried a role at all.
    // JSX rather than `createElement` here alone: `Alert` declares `children` as a required
    // prop, which the three-argument form does not satisfy and the props-object form trips
    // `react(no-children-prop)` on.
    const ui = mount(() => (
      <div>
        <Alert tone="c" label="REFUSED">No.</Alert>
        <Alert tone="i" label="LISTS">Two lists.</Alert>
      </div>
    ));
    expect(ui.host.querySelector(".al.c")!.getAttribute("role")).toBe("alert");
    expect(ui.host.querySelector(".al.i")!.getAttribute("role")).toBe("status");
  });
});

describe("the price-list prose counts what is actually deployed", () => {
  it("says a list covers its one counter, not that it is shared", () => {
    const saved = [...OUTLETS];
    OUTLETS.splice(0, OUTLETS.length, "coffee");
    try {
      act(() => { as("manager"); useApp.setState({ shopFilter: null }); });
      const ui = mount(manager.prices);
      expect(ui.text()).toContain(`covers ${LOC.coffee.n}`);
      expect(ui.text()).not.toContain("is shared by");
    } finally {
      OUTLETS.splice(0, OUTLETS.length, ...saved);
    }
  });

  it("says nothing about lists before the locations have landed", () => {
    // What the screen sees between sign-in and the snapshot: `OUTLETS` is a deployment constant
    // and is already there, `LOC` is a registry filled in place and is not. `LOC[l].list` threw
    // outright, and the header read "0 lists cover the 0 counters".
    const saved = OUTLETS.map((l) => LOC[l]);
    for (const l of OUTLETS) delete LOC[l];
    try {
      act(() => { as("manager"); useApp.setState({ shopFilter: null }); });
      const ui = mount(manager.prices);
      expect(ui.text()).toContain("No outlet is configured");
      expect(ui.text()).not.toContain("0 lists");
      expect(ui.text()).not.toContain("0 counters");
    } finally {
      OUTLETS.forEach((l, i) => { LOC[l] = saved[i]; });
    }
  });
});

describe("the account-management page", () => {
  it("renders the create-account form and the account table for a flagged account", () => {
    act(() => {
      as("manager");
      useApp.setState({
        user: { ...useApp.getState().user!, admin: true },
        accounts: [{
          id: "u1", emp: "RC-4471", n: "Kavitha Raman", e: "kavitha.r@royalcare.in", ph: "98430 22118",
          r: "counter", rl: "Counter Operator", loc: "coffee", col: "#B45309",
          active: true, mustChangePassword: false, admin: false,
        }],
      });
    });
    const ui = mount(AdminUsers);
    expect(ui.text()).toContain("Manage staff accounts");
    expect(ui.text()).toContain("Create an account");
    expect(ui.text()).toContain("RC-4471");
    expect(ui.text()).toContain("Kavitha Raman");
    ui.unmount();
  });

  it("shows a created account's one-time password once, under the number the server gave, and the create form again empty", async () => {
    const createAccount = vi.fn(async () => ({ emp: "RC-4472", password: "a-one-time-password" }));
    act(() => {
      as("manager");
      useApp.setState({ user: { ...useApp.getState().user!, admin: true }, createAccount });
    });
    const ui = mount(AdminUsers);
    typeIn(ui.field("Name"), "Anitha R");
    typeIn(ui.field("Email"), "anitha.r@royalcare.in");
    await settle(() => { ui.button("Create account").click(); });
    // No employee number in the body: the server assigns it.
    expect(createAccount).toHaveBeenCalledWith({ name: "Anitha R", email: "anitha.r@royalcare.in", role: "counter", loc: "rest", phone: undefined });
    expect(ui.text()).toContain("RC-4472's temporary password is a-one-time-password");
    expect(ui.field("Name").value).toBe("");
    ui.unmount();
  });
});

// ---- admin: the support desk
describe("the admin's support desk", () => {
  const ticket = (id: string, over: Partial<Dated<SupportTicket>>): Dated<SupportTicket> => ({
    id, topic: "A number looks wrong", subject: `Subject of ${id}`, priority: "Normal", st: "Open",
    by: "Kavitha Raman", role: "counter", loc: "coffee", at: "09:12", iso: "2026-09-04T03:42:00.000Z", screen: "Dashboard",
    messages: [{ id: "m1", from: "user", who: "Kavitha Raman", at: "09:12", body: "Cash collected reads zero." }],
    ...over,
  });
  const DESK = [
    ticket("SUP-0101", { priority: "Urgent" }),
    ticket("SUP-0102", { by: "Suresh Muthu", role: "store", loc: "store", st: "With support" }),
    ticket("SUP-0103", { st: "Resolved", rating: 4 }),
    ticket("SUP-0104", { st: "Closed" }),
  ];
  /** A textarea's own value setter, the way React hears typing into one. */
  const typeArea = (el: HTMLTextAreaElement, v: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const rowOf = (host: HTMLElement, id: string) =>
    [...host.querySelectorAll("tbody tr")].find((r) => (r.textContent ?? "").includes(id)) as HTMLElement | undefined;
  const flagged = (extra: Record<string, unknown> = {}) => act(() => {
    as("manager");
    useApp.setState({ user: { ...useApp.getState().user!, admin: true }, deskTickets: DESK, ...extra });
  });

  it("lists what still needs support from every role, most pressing first, and the rest behind the status filter", () => {
    flagged();
    const ui = mount(AdminSupport);
    const ids = [...ui.host.querySelectorAll("tbody tr")].map((r) => (r.textContent ?? "").match(/SUP-\d+/)?.[0]);
    expect(ids).toEqual(["SUP-0101", "SUP-0102"]);
    expect(ui.text()).toContain("Suresh Muthu");
    expect(ui.text()).toContain("Store Keeper · Central Store");
    expect(ui.text()).toContain("4.01 of 4 rated");
    act(() => {
      const sel = ui.host.querySelector<HTMLSelectElement>('select[aria-label="Status"]')!;
      sel.value = "All";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(ui.host.querySelectorAll("tbody tr")).toHaveLength(4);
  });

  it("offers on an open ticket every move the table has, and on a resolved one only what it still allows", () => {
    flagged();
    const ui = mount(AdminSupport);
    act(() => { rowOf(ui.host, "SUP-0101")!.click(); });
    expect(ui.text()).toContain("Cash collected reads zero.");
    for (const b of ["Send", "Send & ask Kavitha", "Send & resolve", "Pick up", "Mark resolved", "Close ticket"]) {
      expect(ui.button(b), b).toBeTruthy();
    }

    act(() => {
      const sel = ui.host.querySelector<HTMLSelectElement>('select[aria-label="Status"]')!;
      sel.value = "Resolved";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => { rowOf(ui.host, "SUP-0103")!.click(); });
    expect(ui.button("Reopen")).toBeTruthy();
    expect(ui.button("Close ticket")).toBeTruthy();
    // Resolved -> Waiting on you is no edge, and a resolved ticket is not resolved again.
    expect(ui.button("Send & ask")).toBeUndefined();
    expect(ui.button("Send & resolve")).toBeUndefined();
    expect(ui.button("Mark resolved")).toBeUndefined();
  });

  it("sends the reply with the status its button names, and empties the box only once the server took it", async () => {
    const replyAsDesk = vi.fn(async () => false);
    flagged({ replyAsDesk });
    const ui = mount(AdminSupport);
    act(() => { rowOf(ui.host, "SUP-0102")!.click(); });
    const box = ui.host.querySelector("textarea")!;
    typeArea(box, "Fixed on our side - reload and it saves.");
    await settle(() => { ui.button("Send & resolve").click(); });
    expect(replyAsDesk).toHaveBeenCalledWith("SUP-0102", "Fixed on our side - reload and it saves.", "Resolved");
    // Refused: the words stay.
    expect(ui.host.querySelector("textarea")!.value).toBe("Fixed on our side - reload and it saves.");

    replyAsDesk.mockResolvedValue(true);
    await settle(() => { ui.button("Send").click(); });
    expect(replyAsDesk).toHaveBeenLastCalledWith("SUP-0102", "Fixed on our side - reload and it saves.", undefined);
    expect(ui.host.querySelector("textarea")!.value).toBe("");
  });

  it("puts accounts and the desk on two tabs, with a count of what needs support, read on the way in", () => {
    const loadDeskTickets = vi.fn(async () => {});
    flagged({ loadDeskTickets, loadAccounts: vi.fn(async () => {}), loadAdminActions: vi.fn(async () => {}) });
    const ui = mount(AdminDashboard);
    expect(loadDeskTickets).toHaveBeenCalledTimes(1);
    expect(ui.text()).toContain("Manage staff accounts");
    const tab = ui.host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]')!;
    expect(tab.textContent).toBe("Support desk2");
    act(() => { tab.click(); });
    expect(ui.text()).toContain("Tickets from every role's Support screen.");
    expect(ui.text()).not.toContain("Manage staff accounts");
  });
});
