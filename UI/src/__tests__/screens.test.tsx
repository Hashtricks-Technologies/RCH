import { beforeEach, describe, expect, it } from "vitest";
import { act, createElement, type ComponentType, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { useApp } from "../store";
import { NAV } from "../nav";
import { DRAWERS } from "../drawers";
import Settings from "../pages/Settings";
import Issues from "../pages/Support";
import Login from "../pages/Login";
import { screens as counter } from "../roles/counter";
import { screens as manager } from "../roles/manager";
import { screens as store } from "../roles/store";
import { screens as prod } from "../roles/prod";
import { screens as buyer } from "../roles/buyer";
import { groupPool, picksFor, type PoolGroup } from "../roles/buyer/ProcurementList";
import { USERS, seedVendors } from "@rch/contract/fixtures";
import type { PoolLine } from "../lib/selectors";
import type { Role, Ticket } from "../types";
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
  for (const u of USERS) {
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
  for (const u of USERS) {
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
  const cases: [string, string, Role][] = [
    ["cbill", "CF/1187", "counter"], ["creq", "REQ-2026-0911", "counter"], ["ctkt", "TKT-0440", "counter"],
    ["mreq", "REQ-2026-0911", "manager"], ["stkt", "TKT-0440", "store"],
    ["pord", "PRD-2026-029", "prod"], ["bprq", "PRQ-2026-013", "buyer"],
    ["bpo", "PO-2026-0140", "buyer"],
    ["bpo", "PO-2026-0141", "buyer"],
    ["bgrn", "PO-2026-0141", "buyer"],
    ["bven", "VN-001", "buyer"],
    ["cconfig", "juice", "counter"],
  ];
  for (const [key, id, role] of cases) {
    it(key, () => {
      act(() => { as(role); });
      const C = DRAWERS[key];
      expect(C, `drawer "${key}" is not registered`).toBeTruthy();
      expect(render(createElement(C, { id })).length).toBeGreaterThan(200);
    });
  }

  // Not a row in `cases` above: the kitchen's ticket window opens on a ticket the kitchen
  // *issued*, and the fixtures seed exactly one ticket, store -> coffee. So the row is set up
  // here instead. What it pins is the whole reason the drawer exists: before it, every kitchen
  // handover went through `handover(id)` with no OTP, which the server records as a supervisor
  // override — the kitchen had a button but nowhere to type what the collector read out.
  it("ptkt gives the kitchen a box for the collector's OTP, and an override behind its own label", () => {
    act(() => {
      as("prod");
      useApp.setState({ tkt: [{
        id: "TKT-0905", req: "PRD-2026-029", from: "kitchen", to: "kiosk",
        lines: [{ it: "puff", qty: 12 }], st: "Issued", otp: "", hist: [{ s: "Issued", who: "Vinoth Prakash", t: "10:12" }],
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

  // Not a row in `cases` above: PO-2026-0142 (milk, butter — neither has a printed MRP)
  // shares the "bgrn" key with PO-2026-0141 (juice, water — both have one), and the shared
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
  // create-mode branch — no vendor loaded, so no Deactivate/Reactivate
  // footer control — that VN-001's row never exercises.
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
});

describe("sign-in", () => {
  it("asks for an employee id and a password", () => {
    act(() => { useApp.setState({ user: null, auth: "signed-out" }); });
    const html = render(createElement(Login));
    expect(html).toContain("Employee id");
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
    // The seeded pool: maida 20 from PRQ-2026-014, milk 25 from PRQ-2026-011 —
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
    // Taking less than the first source covers stays on that source alone —
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
    // ends the day carrying two — and the server hands them over oldest first. The card used
    // to print the first one it found, which is the withdrawn one.
    act(() => {
      as("prod");
      useApp.setState({
        pord: [{ id: "PRD-2026-029", from: "kiosk", by: "Ramesh Kumar", at: "07:10",
          lines: [{ it: "puff", qty: 40 }], st: "Dispatched", note: "",
          hist: [{ s: "New", who: "Ramesh Kumar", t: "07:10" }] }],
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
 * question a screen may ask before rendering the panel — and it is the question both of these
 * screens used to get wrong in opposite directions.
 */
describe("the collection OTP reaches the collector's screen and no other", () => {
  const tkt = (over: Partial<Ticket>): Ticket => ({
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

  it("never draws it on a ticket the kitchen issued out — the server sends it none", () => {
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
    // to read "used at handover" for both — which is a lie about a ticket nobody collected.
    act(() => {
      as("prod");
      useApp.setState({ tkt: [tkt({ id: "TKT-0904", st: "Cancelled", otp: "" })] });
    });
    const html = render(createElement(prod.tickets));
    expect(html).not.toContain("otp-v");
    expect(html).toContain("withdrawn — the OTP was never used");
    expect(html).not.toContain("used at handover");
  });
});

/** The counter's own ticket drawer opens on both directions, and almost every sentence on it
 *  turns on which one — including whether a receipt may be confirmed at all. */
describe("the counter's ticket drawer reads its own direction", () => {
  const open = (t: Ticket) => {
    act(() => { as("counter"); useApp.setState({ tkt: [t] }); });
    return render(createElement(DRAWERS.ctkt, { id: t.id }));
  };
  const inbound = (over: Partial<Ticket> = {}): Ticket => ({
    id: "TKT-0910", req: "REQ-2026-0909", from: "store", to: "coffee",
    lines: [{ it: "milk", qty: 6 }], st: "Issued", otp: "135791", hist: [], ...over,
  });
  const sent = (over: Partial<Ticket> = {}): Ticket =>
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
