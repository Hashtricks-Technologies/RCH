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
// The price-list screen is hidden behind `PRICE_LISTS_ENABLED` (roles/manager/index.tsx); its
// cases below mount it directly.
import PriceLists from "../roles/manager/Prices";
import { screens as store } from "../roles/store";
import { screens as prod } from "../roles/prod";
import { screens as buyer } from "../roles/buyer";
import { groupPool, picksFor, type PoolGroup } from "../roles/buyer/ProcurementList";
import { REPORTS } from "../roles/store/Reports";
import { bodyKey } from "../roles/manager/ApprovalDrawer";
import { IT as FXIT, USERS, seedVendors } from "@rch/contract/fixtures";
// ---- item patch ----
import { IT, LOC, PRICE_LISTS, hydrateLocations, hydratePriceLists } from "../data/master";
import { allOutlets, madeItems } from "../lib/selectors";
import { Alert } from "../ui/kit";
import type { PoolLine } from "../lib/selectors";
import type { Bill, Dated, DatedDoc, RegisterReport, Role, StockRequest, SupportTicket, Ticket, Trailed } from "../types";
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
    cadjreq: ["ADJREQ-2026-01", "counter"],
    creqadj: ["new", "counter"],
    madjreq: ["ADJREQ-2026-01", "manager"],
    // ---- audit log: opens on an event id. The read behind it goes to the audit service, which
    // is not stubbed here, so this renders the drawer's own reading state.
    auditEntry: ["43", "manager"],
    baddpool: ["new", "buyer"],
    bcontract: ["new", "buyer"],
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
    plset: ["prices", "manager"],
    // The kitchen's order history is a list, not a document, so like `korder` its id is a
    // placeholder - the drawer never reads it.
    phist: ["all", "prod"],
    pnew: ["new", "prod"],
    pord: ["PRD-2026-029", "prod"],
    ptkt: ["TKT-0440", "prod"],
    // ---- party billing: a statement is keyed `<kind>:<id>`, and the read behind it is not
    // stubbed here, so this renders the drawer's own reading state - the same arrangement
    // `auditEntry` above is in.
    stmt: ["doctor:DR-118", "manager"],
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
    // No override, and nothing that reads like one: the code is the whole authorisation.
    expect(html).not.toContain("supervisor override");
    expect(html).not.toContain("without the OTP");
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

  // Not a row in `cases` above: id "milk" opens Configure for a raw material that is
  // not on the Coffee Shop's own menu, which shares the "cconfig" key with "juice"
  // (a sellable product) and would collide on the shared loop's test title.
  it("cconfig shows a note instead of a switch for a raw material it does not sell", () => {
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
    expect(html).toContain("The name, the group, the HSN code, the reorder level, the shelf life and the stock-request source belong to the store, the buyer and the kitchen");
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

  it("greys the default-source picker for the manager, opens it for the others, and hides it for an MTO item", () => {
    expect(open("manager")).toContain("The store, the buyer or the kitchen sets this.");
    for (const role of ["store", "buyer", "prod"] as Role[]) {
      expect(open(role)).toContain("The desk that supplies this item when an outlet asks for it.");
    }
    // "capp" is made to order - it holds no stock, so there is no routing to set for it.
    expect(open("store", "capp")).not.toContain("Stock request routing");
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
    expect(html).toContain("Leave the box as it is to keep the current MRP; emptying it changes nothing");
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
    // `madeItems()` is "every FG on the master", read by all three kitchen screens. A retired
    // one is still on it, so it kept its Make tile - and `POST /batches` reads `loadItems`,
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
    // Through the manager's drawer, whose outlet picker opens on the first open outlet by
    // name - the Coffee Shop, reachable this way rather than through a counter session because
    // the fixtures' two counter accounts are the Coffee Shop itself and the Snack Kiosk.
    act(() => { as("manager"); });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(MemoryRouter, null, createElement(DRAWERS.korder, { id: "new" }))); });

    // The drawer's own picker (the form's "For" field carries the same aria-label, read-only).
    act(() => {
      const sel = host.querySelector<HTMLSelectElement>("select[aria-label='Outlet']")!;
      sel.value = "coffee";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // The Coffee Shop's menu is capp, chai, juice, water, bisc, chips - not one finished good:
    // capp and chai are made at the till the moment they are sold, and the rest come off the
    // central store's shelf. Nothing downstream could fill an order for any of them, so the
    // picker offers nothing at all rather than a product the kitchen cannot make for this outlet.
    expect([...host.querySelectorAll("select[aria-label='Product 1'] option")].map((o) => o.textContent)).toEqual([]);

    // Switching to the Restaurant proves the emptiness above is about the Coffee Shop's menu,
    // not a picker that is broken outright: the Restaurant's puff/sand/salad are finished goods.
    act(() => {
      const sel = host.querySelector<HTMLSelectElement>("select[aria-label='Outlet']")!;
      sel.value = "rest";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const restOptions = [...host.querySelectorAll("select[aria-label='Product 1'] option")].map((o) => o.textContent);
    expect(restOptions).toEqual(["Garden salad", "Veg puffs", "Veg sandwich"]);

    act(() => { root.unmount(); });
    host.remove();
  });

  it("offers no kitchen-routed item on the unified request until one is on this counter's own menu", () => {
    act(() => { as("counter"); });                       // Kavitha, Coffee Shop
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(MemoryRouter, null, createElement(counter.requests))); });
    act(() => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Add item")!.click();
    });
    const options = () => [...host.querySelectorAll("select[aria-label='Item on row 1'] option")].map((o) => o.textContent);

    // The Coffee Shop sells capp, chai, juice, water, bisc, chips - two made at the till and
    // four bought in, and not one finished good - so nothing on the picker routes to the
    // kitchen. Every option offered still comes off the central store instead.
    expect(options().some((t) => t?.startsWith("Veg puffs") || t?.startsWith("Veg sandwich") || t?.startsWith("Garden salad"))).toBe(false);

    // Once the outlet manager lists a finished good there, it appears - and routes to the
    // kitchen without the operator ever choosing that.
    act(() => {
      const menu = useApp.getState().menu;
      useApp.setState({ menu: { ...menu, coffee: [...menu.coffee, "puff"] } });
    });
    expect(options().some((t) => t?.startsWith("Veg puffs"))).toBe(true);

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
      useApp.setState({ pay, readCredit: async () => null });
      useApp.getState().addToCart("coffee", "juice", 1);
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
    const ui = mount(PriceLists);

    const box = ui.labelled("New price for Real Juice 200ml");
    typeIn(box, "37");
    const save = [...box.closest("tr")!.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    await settle(() => { save.click(); });

    expect(savePrice).toHaveBeenCalledWith("PL-002", "juice", 37);
    expect(ui.labelled("New price for Real Juice 200ml").value).toBe("37");
  });
});

describe("the price lists tab", () => {
  it("lists every price list, filtered by outlet and by name", () => {
    act(() => { as("manager"); useApp.setState({ shopFilter: null }); });
    const ui = mount(PriceLists);
    act(() => { ui.button("Price lists").click(); });
    expect(ui.text()).toContain("List A");
    expect(ui.text()).toContain("List B");

    const outletFilter = ui.host.querySelector<HTMLSelectElement>('select[aria-label="Outlet"]')!;
    act(() => {
      outletFilter.value = "Coffee Shop";
      outletFilter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(ui.text()).toContain("List B");
    expect(ui.text()).not.toContain("List A");
  });

  it("blocks deleting a list still active at an outlet, and allows an unattached one", () => {
    hydratePriceLists([...Object.values(PRICE_LISTS), { id: "PL-999", name: "Spare", outlets: [] }]);
    act(() => { as("manager"); useApp.setState((s) => ({ shopFilter: null, catalogVersion: s.catalogVersion + 1 })); });
    const ui = mount(PriceLists);
    act(() => { ui.button("Price lists").click(); });

    const rowFor = (name: string) => [...ui.host.querySelectorAll("tr")].find((r) => (r.textContent ?? "").includes(name))!;
    expect(rowFor("List A").querySelector("button")?.hasAttribute("disabled")).toBe(true);
    expect([...rowFor("Spare").querySelectorAll("button")].some((b) => b.textContent === "Delete" && !b.hasAttribute("disabled"))).toBe(true);
  });

  it("opens the settings drawer from the outlet page, which no longer carries the controls itself", () => {
    const openDrawer = vi.fn();
    act(() => { as("manager"); useApp.setState({ openDrawer, shopFilter: "coffee" }); });
    const ui = mount(PriceLists);

    // The two controls that used to sit above "Add a product". "Add a product" itself stays.
    expect(ui.text()).not.toContain("Create a new list for this outlet");
    expect([...ui.host.querySelectorAll("label")].map((l) => l.textContent)).not.toContain("Active list");
    expect(ui.text()).toContain("Add a product");

    act(() => { ui.button("Settings").click(); });
    expect(openDrawer).toHaveBeenCalledWith("plset", "prices");
  });
});

describe("an outlet on no price list yet (I2)", () => {
  it("names it 'no list yet' on the landing banner rather than a blank list", () => {
    hydrateLocations({ ...LOC, kiosk: { ...LOC.kiosk, list: undefined } });
    act(() => { as("manager"); useApp.setState({ shopFilter: null }); });
    const ui = mount(PriceLists);

    expect(ui.text()).toContain("no list yet");
    // Nothing else prints as a blank name for the outlet the fixture just took the list off.
    expect(ui.host.querySelector("b")?.textContent).not.toBe("");
  });

  it("offers no price table to save to, and no path to a savePrice(\"\", …) call", () => {
    hydrateLocations({ ...LOC, kiosk: { ...LOC.kiosk, list: undefined } });
    const savePrice = vi.fn(async () => true);
    act(() => { as("manager"); useApp.setState({ savePrice, shopFilter: "kiosk" }); });
    const ui = mount(PriceLists);

    expect(ui.text()).toContain("no list yet");
    expect(ui.text()).toContain("create one with New price list, then attach it");
    // The price table - and its Save button, whose click would post to `/api/prices//<it>` - is
    // not rendered at all, so there is no button anywhere that can call `savePrice` with an
    // empty list id.
    expect([...ui.host.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim())).not.toContain("Save");
    expect(ui.host.querySelector('input[aria-label^="New price for"]')).toBeNull();
    expect(savePrice).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------
 * Creating a price list: a dialog raised from the Prices page's own button,
 * not a section buried in Settings - and it can start from nothing, which is
 * the only way the very first list on a hospital ever gets made.
 * ---------------------------------------------------------------------- */
describe("the New price list dialog", () => {
  const openDialog = async () => {
    const ui = mount(PriceLists);
    await settle(() => { ui.button("New price list").click(); });
    return ui;
  };
  const startFrom = async (ui: ReturnType<typeof mount>, v: string) => {
    const el = ui.host.querySelector<HTMLSelectElement>('select[aria-label="Start from"]')!;
    await settle(() => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); });
  };

  it("copies from the outlet picked on the form", async () => {
    const createPriceList = vi.fn(async () => ({ id: "PL-010", name: "Weekend Rates", outlets: [] }));
    act(() => { as("manager"); useApp.setState({ createPriceList, shopFilter: null }); });
    const ui = await openDialog();

    typeIn(ui.field("List name"), "Weekend Rates");
    await startFrom(ui, "coffee");
    await settle(() => { ui.button("Create price list").click(); });

    expect(createPriceList).toHaveBeenCalledWith("Weekend Rates", "coffee");
    // Taken, so the dialog closes; a refusal would have left it open with the name in it.
    expect(ui.host.querySelector(".modal")).toBeNull();
  });

  it("sends no source at all when the list starts empty - the first list a hospital ever has", async () => {
    // Every outlet is on no list, so there is nothing to copy from. While a source was
    // required, this was the one list nobody could create: every option the form offered
    // answered "has no price list to clone".
    hydrateLocations(Object.fromEntries(Object.entries(LOC).map(([k, l]) => [k, { ...l, list: undefined }])));
    const createPriceList = vi.fn(async () => ({ id: "PL-001", name: "Opening Prices", outlets: [] }));
    act(() => { as("manager"); useApp.setState({ createPriceList, shopFilter: null }); });
    const ui = await openDialog();

    expect(ui.text()).toContain("No outlet is on a list yet");
    typeIn(ui.field("List name"), "Opening Prices");
    await settle(() => { ui.button("Create price list").click(); });

    expect(createPriceList).toHaveBeenCalledWith("Opening Prices", undefined);
  });

  it("keeps an unnamed list in the browser - the button is shut, not the request refused", async () => {
    const createPriceList = vi.fn();
    act(() => { as("manager"); useApp.setState({ createPriceList, shopFilter: null }); });
    const ui = await openDialog();

    expect(ui.button("Create price list").disabled).toBe(true);
    await settle(() => { ui.button("Create price list").click(); });
    expect(createPriceList).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------------
 * The price-list settings drawer: the mapping of every outlet to the list it
 * charges from, read in one place rather than one outlet at a time.
 * ---------------------------------------------------------------------- */
describe("the price list settings drawer", () => {
  const openSettings = () => mount(() => createElement(DRAWERS.plset, { id: "prices" }));
  const select = (ui: ReturnType<typeof mount>, aria: string) =>
    ui.host.querySelector<HTMLSelectElement>(`select[aria-label="${aria}"]`)!;
  const pick = async (el: HTMLSelectElement, v: string) => {
    await settle(() => {
      el.value = v;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  /** The drawer draws two tables - the outlet mappings, then every list - and a list's name
   *  appears in both, so a row is looked up inside the one being asked about. */
  const rowIn = (ui: ReturnType<typeof mount>, table: "mappings" | "lists", text: string) => {
    const t = ui.host.querySelectorAll("table")[table === "mappings" ? 0 : 1];
    return [...t.querySelectorAll("tbody tr")].find((r) => (r.textContent ?? "").includes(text))!;
  };

  it("maps every outlet at once and names who shares a list", () => {
    act(() => { as("manager"); });
    const ui = openSettings();
    const row = (name: string) => rowIn(ui, "mappings", name);

    // Restaurant and Snack Kiosk are both on List A in the fixtures; the Coffee Shop is alone
    // on List B. The whole point of the panel is that this is legible without drilling in.
    expect(row("Restaurant").textContent).toContain("List A");
    expect(row("Restaurant").textContent).toContain("Snack Kiosk");
    expect(row("Snack Kiosk").textContent).toContain("Restaurant");
    expect(row("Coffee Shop").textContent).toContain("List B");
    expect(row("Coffee Shop").textContent).toContain("This outlet only");
  });

  it("attaching a different list calls setOutletPriceList for that outlet", async () => {
    const setOutletPriceList = vi.fn(async () => true);
    act(() => { as("manager"); useApp.setState({ setOutletPriceList }); });
    const ui = openSettings();

    await pick(select(ui, "Price list for Coffee Shop"), "PL-001");

    expect(setOutletPriceList).toHaveBeenCalledWith("coffee", "PL-001");
  });

  it("blocks deleting a list an outlet still charges from, and allows an unattached one", () => {
    hydratePriceLists([...Object.values(PRICE_LISTS), { id: "PL-999", name: "Spare", outlets: [] }]);
    act(() => { as("manager"); useApp.setState((s) => ({ catalogVersion: s.catalogVersion + 1 })); });
    const ui = openSettings();

    const row = (name: string) => rowIn(ui, "lists", name);
    const del = (name: string) => [...row(name).querySelectorAll("button")].find((b) => b.textContent === "Delete")!;
    expect(del("List A").hasAttribute("disabled")).toBe(true);
    // The reason is on the disabled control rather than waiting behind a click the server turns away.
    expect(row("List A").textContent).toContain("Snack Kiosk and Restaurant");
    expect(del("Spare").hasAttribute("disabled")).toBe(false);
  });

  it("deletes an unattached list behind a second press", async () => {
    const deletePriceList = vi.fn(async () => true);
    hydratePriceLists([...Object.values(PRICE_LISTS), { id: "PL-999", name: "Spare", outlets: [] }]);
    act(() => { as("manager"); useApp.setState((s) => ({ deletePriceList, catalogVersion: s.catalogVersion + 1 })); });
    const ui = openSettings();

    const press = (label: string) =>
      [...rowIn(ui, "lists", "Spare").querySelectorAll("button")].find((b) => b.textContent === label)!;
    act(() => { press("Delete").click(); });
    await settle(() => { press("Confirm delete").click(); });

    expect(deletePriceList).toHaveBeenCalledWith("PL-999");
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
      useApp.getState().addToCart("coffee", "juice", 1);
      useApp.setState({
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
      useApp.getState().addToCart("coffee", "juice", 1);
      useApp.setState({
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
  it("routes each line to the desk its own item names, with no source ever picked", () => {
    act(() => {
      as("counter");                                    // Kavitha, Coffee Shop
      const menu = useApp.getState().menu;
      useApp.setState({ menu: { ...menu, coffee: [...menu.coffee, "puff"] } });
    });
    const ui = mount(counter.requests);
    act(() => { ui.button("Add item").click(); });
    act(() => { ui.button("Add item").click(); });

    const rowSelect = (i: number) => ui.host.querySelector<HTMLSelectElement>(`select[aria-label="Item on row ${i}"]`)!;
    const pick = (el: HTMLSelectElement, v: string) => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const goesTo = (i: number) => ui.host.querySelectorAll("tbody tr")[i - 1]!.querySelectorAll("td")[4]!.textContent;

    // "milk" (RAW, no `src` set) falls back to its type's default - the store; "puff" (FG,
    // freshly listed on this till) falls back to the kitchen. Neither was chosen, only named.
    act(() => { pick(rowSelect(1), "milk"); });
    act(() => { pick(rowSelect(2), "puff"); });
    expect(goesTo(1)).toBe("Central Store");
    expect(goesTo(2)).toBe("Central Kitchen");
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
    const savedRest = LOC.rest;
    const savedKiosk = LOC.kiosk;
    delete LOC.rest;
    delete LOC.kiosk;
    try {
      act(() => { as("manager"); useApp.setState({ shopFilter: null }); });
      const ui = mount(PriceLists);
      expect(ui.text()).toContain(`covers ${LOC.coffee.n}`);
      expect(ui.text()).not.toContain("is shared by");
    } finally {
      LOC.rest = savedRest;
      LOC.kiosk = savedKiosk;
    }
  });

  it("says nothing about lists before the locations have landed", () => {
    // What the screen sees between sign-in and the snapshot: outlets are read straight off
    // `LOC`, a registry filled in place, and are empty until it is. `LOC[l].list` threw
    // outright, and the header read "0 lists cover the 0 counters".
    const outlets = allOutlets();
    const saved = outlets.map((l) => LOC[l]);
    for (const l of outlets) delete LOC[l];
    try {
      act(() => { as("manager"); useApp.setState({ shopFilter: null }); });
      const ui = mount(PriceLists);
      expect(ui.text()).toContain("No outlet is configured");
      expect(ui.text()).not.toContain("0 lists");
      expect(ui.text()).not.toContain("0 counters");
    } finally {
      outlets.forEach((l, i) => { LOC[l] = saved[i]; });
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
          r: "counter", rl: "Counter Operator", loc: "coffee", col: "#B45309", postings: ["coffee"],
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
      useApp.setState({
        user: { ...useApp.getState().user!, admin: true }, createAccount,
        loadAdminLocations: vi.fn(async () => {}),
        adminLocations: [{ key: "rest", n: "Restaurant", c: "OT-R1", type: "Outlet", floor: "Floor 1", cc: "CC-RST", active: true, staff: 1 }],
      });
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
  const ADMIN_LOCS = [
    { key: "store", n: "Central Store", c: "WH-CS", type: "Store" as const, floor: "Basement", cc: "CC-STO", active: true, staff: 2 },
    { key: "coffee", n: "Coffee Shop", c: "OT-CS", type: "Outlet" as const, floor: "Ground", cc: "CC-CFE", list: "A" as const, active: true, staff: 1 },
  ];
  const flagged = (extra: Record<string, unknown> = {}) => act(() => {
    as("manager");
    useApp.setState({
      user: { ...useApp.getState().user!, admin: true }, deskTickets: DESK, adminLocations: ADMIN_LOCS,
      loadAdminLocations: vi.fn(async () => {}), ...extra,
    });
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

  it("puts accounts, outlets and the desk on three tabs, with a count of what needs support, read on the way in", () => {
    const loadDeskTickets = vi.fn(async () => {});
    flagged({ loadDeskTickets, loadAccounts: vi.fn(async () => {}), loadAdminActions: vi.fn(async () => {}) });
    const ui = mount(AdminDashboard);
    expect(loadDeskTickets).toHaveBeenCalledTimes(1);
    expect(ui.text()).toContain("Manage staff accounts");
    const tabs = [...ui.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const tab = tabs.find((b) => b.textContent?.startsWith("Support desk"))!;
    expect(tab.getAttribute("aria-selected")).toBe("false");
    expect(tab.textContent).toBe("Support desk2");
    act(() => { tab.click(); });
    expect(ui.text()).toContain("Tickets from every role's Support screen.");
    expect(ui.text()).not.toContain("Manage staff accounts");
  });
});

/* ----------------------------------------------------------------------
 * The register: the X read mid-shift, and the Z that closes the day.
 *
 * One screen (`ui/Register.tsx`) serves the counter and the manager, so both are driven here
 * through `REGISTRY`, which also proves the three files agree - `nav.ts`, each role's
 * `index.tsx`, and `App.tsx`'s lookup.
 * ---------------------------------------------------------------------- */

/** Figures modelled on the hospital's own Z slip. Seven lines are zero on purpose. */
const TOTALS: RegisterReport["totals"] = {
  grossSales: 4820, discount: 120, nettSales: 4700, creditSales: 900,
  voidAmount: 60, voidBills: 1,
  tip: 0, parcelCharge: 0, deliveryCharge: 0, additionalCharge: 0,
  complimentary: 0, unCollected: 0, unCollectedDiscount: 0,
  tenders: [{ tender: "Cash", amount: 2600, bills: 18 }, { tender: "UPI", amount: 1200, bills: 7 }],
  collected: 3800,
  oldBills: [{ mode: "Cash", amount: 450 }], oldBillsTotal: 450,
  sgst: 111.9, cgst: 111.9, taxTotal: 223.8,
  billCount: 26,
};
const xReport = (over: Partial<RegisterReport> = {}): RegisterReport => ({
  kind: "X", zNo: null, sessionId: "SES-coffee-12", loc: "coffee", previousZNo: "Z-0041",
  openedAt: "2026-09-17T13:00:00.000Z", closedAt: null,
  takenAt: "2026-09-18T05:30:00.000Z", takenBy: "Kavitha Raman", totals: TOTALS, ...over,
});
const zReport = (over: Partial<RegisterReport> = {}): RegisterReport => xReport({
  kind: "Z", zNo: "Z-0042", closedAt: "2026-09-18T05:30:00.000Z", ...over,
});

const kpiValue = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll(".kpi")]
    .find((k) => k.querySelector(".kl")?.textContent === label)
    ?.querySelector(".kv")?.textContent ?? "";

const aBill = (no: string, iso: string, tot: number): Dated<Bill> => ({
  no, loc: "coffee", opr: "Kavitha Raman", oprCol: "#0EA5E9", tot, tax: 0,
  t: "10:00", iso, pay: "Cash", lines: [{ it: "juice", qty: 2, rate: tot / 2 }],
});

describe("the register", () => {
  let printed: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    printed = vi.fn();
    Object.defineProperty(window, "print", { value: printed, configurable: true, writable: true });
  });

  async function openRegister(role: Role, o: {
    x?: () => Promise<RegisterReport | null>;
    zs?: () => Promise<RegisterReport[] | null>;
    close?: () => Promise<RegisterReport | null>;
  } = {}) {
    const readXReport = vi.fn(o.x ?? (async () => xReport()));
    const readZReports = vi.fn(o.zs ?? (async () => [zReport()]));
    const closeRegister = vi.fn(o.close ?? (async () => zReport()));
    act(() => { as(role); useApp.setState({ readXReport, readZReports, closeRegister }); });
    const ui = mount(REGISTRY[role].register);
    await settle(() => { /* let the two reads land */ });
    return { ui, readXReport, readZReports, closeRegister };
  }

  it("counter: reads its own outlet's open session and offers both readings", async () => {
    const { ui, readXReport, readZReports } = await openRegister("counter");
    expect(readXReport).toHaveBeenCalledWith("coffee");
    expect(readZReports).toHaveBeenCalledWith("coffee");
    expect(ui.text()).toContain("Take X-report");
    expect(ui.text()).toContain("Close register & take Z");
    // The session it follows, so the window is Z to Z and says so.
    expect(ui.text()).toContain("Z-0041");
    expect(kpiValue(ui.host, "Nett sales this session")).toBe("₹4,700");
    // The Z already closed here is on the list, not in the takings.
    expect(ui.text()).toContain("Z-0042");
    // A counter has exactly one register: no outlet picker.
    expect(ui.host.querySelector('select[aria-label="Outlet"]')).toBeNull();
  });

  it("manager: the same register, over any open outlet", async () => {
    const { ui, readXReport } = await openRegister("manager");
    expect(readXReport).toHaveBeenCalledTimes(1);
    expect(ui.host.querySelector('select[aria-label="Outlet"]')).toBeTruthy();
    expect(ui.text()).toContain("Take X-report");
    expect(ui.text()).toContain("Close register & take Z");
  });

  it("an X re-reads and prints, and closes nothing", async () => {
    const { ui, readXReport, readZReports, closeRegister } = await openRegister("counter");
    expect(readXReport).toHaveBeenCalledTimes(1);
    await settle(() => { ui.button("Take X-report").click(); });
    // Read again, printed, and the register is exactly where it was: an X is not a document.
    expect(readXReport).toHaveBeenCalledTimes(2);
    expect(readZReports).toHaveBeenCalledTimes(2);
    expect(printed).toHaveBeenCalled();
    expect(closeRegister).not.toHaveBeenCalled();
    expect(ui.text()).not.toContain("It cannot be undone");
  });

  it("will not close the register until the irreversibility has been confirmed", async () => {
    const { ui, closeRegister } = await openRegister("counter");
    act(() => { ui.button("Close register & take Z").click(); });
    // One press is a question, not a Z.
    expect(closeRegister).not.toHaveBeenCalled();
    expect(ui.text()).toContain("It cannot be undone or taken again");
    expect(ui.text()).toContain("the next sale opens a new one");
    expect(ui.button("Keep it open")).toBeTruthy();

    typeIn(ui.field("Counted cash"), "2600");
    await settle(() => { ui.button("Yes, take the Z").click(); });
    expect(closeRegister).toHaveBeenCalledWith("coffee", 2600);
    // The Z the server answered with goes straight onto the paper.
    expect(printed).toHaveBeenCalled();
    expect(ui.host.querySelector(".print-slip")!.textContent).toContain("Z-0042");
  });

  it("prints every line the hospital's own slip carries, the zeros included, in its order", async () => {
    const { ui } = await openRegister("counter");
    const slip = ui.host.querySelector(".print-slip")!;
    const text = slip.textContent ?? "";
    for (const line of [
      "Tip", "Parcel charge", "Delivery charge", "Additional charge", "Complimentary",
      "Un-collected", "Un-collected discount",
    ]) expect(text, `${line} is missing from the slip`).toContain(line);
    // Those seven, and only those seven, are printed as a zero - on purpose, so the slip matches
    // the one the counters already read.
    expect([...slip.querySelectorAll("td")].filter((td) => td.textContent === "₹0.00")).toHaveLength(7);
    // Sales -> collections -> old bills -> tax -> totals, the order the till report reads in.
    expect(text.indexOf("Gross sales")).toBeLessThan(text.indexOf("Collections"));
    expect(text.indexOf("Collections")).toBeLessThan(text.indexOf("Old bills"));
    expect(text.indexOf("Old bills")).toBeLessThan(text.indexOf("SGST"));
    expect(text.indexOf("SGST")).toBeLessThan(text.indexOf("Totals"));
    // Old bills are collection against an earlier session, never sale.
    expect(text).toContain("not part of nett sales");
  });

  it("says the register could not be read, never that nothing was taken", async () => {
    const { ui } = await openRegister("counter", { x: async () => null, zs: async () => null });
    expect(ui.text()).toContain("Could not read the register");
    expect(ui.text()).toContain("This is not a session that took nothing");
    expect(ui.text()).toContain("Could not read the closed sessions");
    // Neither an empty till report nor an empty history: both would be a claim about the money.
    expect(ui.text()).not.toContain("₹0.00");
    expect(ui.text()).not.toContain("This register has never been closed");
    expect(ui.host.querySelector(".print-slip")).toBeNull();
  });

  it("the counter's dashboard counts from the open session, not from midnight", async () => {
    const now = Date.now();
    const opened = new Date(now - 3 * 3600_000).toISOString();
    const readXReport = vi.fn(async () => xReport({ openedAt: opened }));
    act(() => {
      as("counter");
      useApp.setState({
        readXReport,
        bills: [
          aBill("CF/2001", new Date(now - 3600_000).toISOString(), 40),
          // Same hospital day, but before the last Z: it belongs to the session already settled.
          aBill("CF/2000", new Date(now - 5 * 3600_000).toISOString(), 900),
        ],
      });
    });
    const ui = mount(REGISTRY.counter.dash);
    await settle(() => { /* let the X land */ });
    expect(kpiValue(ui.host, "Billed this session")).toBe("₹40");
    expect(kpiValue(ui.host, "Bills raised")).toBe("1");
    // The window is named by the Z it runs from, never by a date.
    expect(ui.text()).toContain("since Z-0041");
  });

  it("the counter's dashboard blanks its takings rather than printing a zero it cannot stand behind", async () => {
    act(() => {
      as("counter");
      useApp.setState({
        readXReport: vi.fn(async () => null),
        bills: [aBill("CF/2001", new Date().toISOString(), 40)],
      });
    });
    const ui = mount(REGISTRY.counter.dash);
    await settle(() => { /* let the failed read land */ });
    expect(kpiValue(ui.host, "Billed this session")).toBe("-");
    expect(ui.text()).toContain("This is not a session that took nothing");
  });

  it("the manager's dashboard sums every outlet's own open session and says the windows differ", async () => {
    const now = Date.now();
    const opened = new Date(now - 2 * 3600_000).toISOString();
    const readXReport = vi.fn(async (loc?: string) =>
      // The kiosk's register did not answer; the other outlets' did.
      (loc === "kiosk" ? null : xReport({ loc: loc ?? "coffee", openedAt: opened })));
    act(() => {
      as("manager");
      useApp.setState({
        readXReport,
        bills: [
          aBill("CF/2001", new Date(now - 3600_000).toISOString(), 40),
          aBill("CF/2000", new Date(now - 5 * 3600_000).toISOString(), 900),
        ],
      });
    });
    const ui = mount(REGISTRY.manager.dash);
    await settle(() => { /* let every outlet's X land */ });
    // One outlet's session, summed - not seven days of bills, and not "today".
    expect(kpiValue(ui.host, "Billed across open sessions")).toBe("₹40");
    expect(ui.text()).toContain("each since its own Z");
    expect(ui.text()).toContain("since Z-0041");
    // The outlet whose register failed is named, and is not reported as having sold nothing.
    expect(ui.text()).toContain("register not read");
    expect(ui.text()).toContain("That is not an outlet that sold nothing");
  });
});
