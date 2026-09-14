import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { screens as counter } from "../roles/counter";
import { screens as prod } from "../roles/prod";
import Approvals from "../roles/manager/Approvals";
import ManagerDashboard from "../roles/manager/Dashboard";
import BuyerDashboard from "../roles/buyer/Dashboard";
import { isToday, now } from "../lib/fmt";
import { applyRequests, applySnapshot } from "../api/wire";
import { useApp } from "../store";
import { as, resetStore, S } from "./fixture";
import * as FX from "@rch/contract/fixtures";
import type { Batch, Bill, Dated, DatedDoc, PurchaseOrder, Requisition } from "../types";

/**
 * A1 - real instants on the wire.
 *
 * `api/wire.ts` used to collapse every ISO stamp to the "HH:MM" the screens print and keep
 * nothing else, which cost the browser two answers it needs on every counter screen:
 *
 *  - "is this today?" - `GET /bills` returns seven days and nothing filtered them, so every
 *    figure at the till labelled "today" was a week's takings;
 *  - "which is the latest?" - `"22:00"` sorts above `"09:00"` whichever day each belongs to,
 *    so yesterday's last row led a list ordered newest-first.
 *
 * `vite.config.ts` pins `TZ=UTC`, so every instant below is chosen to sit on the far side of an
 * IST midnight from its UTC date: 2026-09-10T20:00Z is already 11 Sep at the hospital. A host
 * comparing UTC days would get each of these the wrong way round.
 */

/** 11 Sep 2026, 10:30 in Asia/Kolkata - mid-morning at the counter, 05:00 UTC. */
const NOW = "2026-09-11T05:00:00.000Z";
/** 11 Sep 01:30 IST. Today at the hospital; still the 10th in UTC. */
const TODAY_EARLY = "2026-09-10T20:00:00.000Z";
/** 10 Sep 23:30 IST. Yesterday at the hospital; also the 10th in UTC. */
const YESTERDAY_LATE = "2026-09-10T18:00:00.000Z";

beforeEach(() => {
  resetStore();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); });

function render(el: React.ReactElement): string {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, el)); });
  const html = host.innerHTML;
  act(() => { root.unmount(); });
  host.remove();
  return html;
}

/** The value on the KPI tile with this label. */
function kpi(html: string, label: string): string {
  const host = document.createElement("div");
  host.innerHTML = html;
  const tile = [...host.querySelectorAll(".kpi")].find((k) => k.querySelector(".kl")?.textContent === label);
  return tile?.querySelector(".kv")?.textContent ?? "";
}

describe("isToday reads the hospital's day, not the host's", () => {
  it("counts an instant after IST midnight as today though UTC still calls it yesterday", () => {
    expect(isToday(TODAY_EARLY)).toBe(true);
  });
  it("does not count last night, which shares its UTC date with this morning", () => {
    expect(isToday(YESTERDAY_LATE)).toBe(false);
  });
  it("answers false for anything it cannot read, rather than counting it in", () => {
    expect(isToday("")).toBe(false);
    expect(isToday("09:12")).toBe(false);
  });
});

describe("the clock a screen stamps itself with is the hospital's", () => {
  it("reads 10:30 at 05:00 UTC, not 05:00", () => {
    // Without `timeZone` this ran five and a half hours behind on any host in UTC - against
    // times in the next column that did convert, so one table showed two clocks.
    expect(now()).toBe("10:30");
  });
});

describe("every 'today' figure at the till is today's", () => {
  /** A counter's snapshot with two bills: one raised this morning, one late last night. */
  const twoDays = () => ({
    user: FX.USERS.find((u) => u.r === "counter"), items: FX.IT, locations: FX.LOC,
    users: FX.USERS, roster: { patients: FX.PATIENTS, staff: FX.STAFF, depts: FX.DEPTS },
    stock: FX.seedStock, rsv: {}, ovr: {}, prices: FX.PL, menu: FX.MENU,
    req: [], tkt: [], prq: [], po: [], pord: [], batch: [], grn: [], vendors: [],
    contracts: [], tickets: [], productReqs: [], shopAsks: [], sales: [], dayLabels: [],
    // ---- adjustments
    adjustments: [],
    bills: [
      { no: "CF/1190", loc: "coffee", opr: "Kavitha Raman", oprCol: "#0EA5E9", tot: 40, tax: 1.9, t: TODAY_EARLY, pay: "Cash", lines: [{ it: "juice", qty: 2, rate: 20 }] },
      { no: "CF/1189", loc: "coffee", opr: "Kavitha Raman", oprCol: "#0EA5E9", tot: 900, tax: 42, t: YESTERDAY_LATE, pay: "Cash", lines: [{ it: "juice", qty: 45, rate: 20 }] },
    ],
  });

  it("sums only the bills raised today, not the week the server sends", () => {
    act(() => { applySnapshot(twoDays() as unknown as Parameters<typeof applySnapshot>[0]); as("counter"); });

    const html = render(createElement(counter.dash));

    // ₹940 was what this tile read: seven days of takings under the word "today".
    expect(kpi(html, "Billed today")).toBe("₹40");
    expect(kpi(html, "Bills raised")).toBe("1");
    expect(kpi(html, "Items sold")).toBe("2");
  });

  it("shows only today's bills on the bills screen, which says today in its own header", () => {
    act(() => { applySnapshot(twoDays() as unknown as Parameters<typeof applySnapshot>[0]); as("counter"); });

    const html = render(createElement(counter.bills));

    expect(html).toContain("CF/1190");
    expect(html).not.toContain("CF/1189");
  });

  it("names this morning's bill as the last one, not last night's later clock face", () => {
    act(() => { applySnapshot(twoDays() as unknown as Parameters<typeof applySnapshot>[0]); as("counter"); });

    // Last night's 23:30 beats this morning's 01:30 on a string comparison, and did.
    expect(kpi(render(createElement(counter.dash)), "Bills raised")).toBe("1");
    expect(S().bills.map((b) => b.iso)).toEqual([TODAY_EARLY, YESTERDAY_LATE]);
  });
});

describe("a list ordered newest-first is ordered by the instant", () => {
  it("puts a request raised this morning above one raised late yesterday", () => {
    act(() => {
      as("manager");
      useApp.setState({
        req: [
          { id: "REQ-2026-0801", from: "coffee", by: "Kavitha Raman", at: "23:30", iso: YESTERDAY_LATE, lines: [{ it: "juice", qty: 4, appr: 0 }], st: "Request sent", ticket: null, mgrNote: "", hist: [] },
          { id: "REQ-2026-0802", from: "kiosk", by: "Deepa Nair", at: "01:30", iso: TODAY_EARLY, lines: [{ it: "juice", qty: 2, appr: 0 }], st: "Request sent", ticket: null, mgrNote: "", hist: [] },
        ],
      });
    });

    const html = render(createElement(Approvals));

    // The desk opens sorted by time, descending. On the printed "HH:MM" the 23:30 row led,
    // which is the oldest ask on the board - the exact opposite of what the sort promises.
    expect(html.indexOf("REQ-2026-0802")).toBeLessThan(html.indexOf("REQ-2026-0801"));
  });
});

describe("the wire keeps the instant beside the time it prints", () => {
  const snap = () => ({
    user: FX.USERS.find((u) => u.r === "manager"), items: FX.IT, locations: FX.LOC,
    users: FX.USERS, roster: { patients: FX.PATIENTS, staff: FX.STAFF, depts: FX.DEPTS },
    stock: {}, rsv: {}, ovr: {}, prices: FX.PL, menu: FX.MENU,
    req: [{ id: "REQ-2026-0810", from: "coffee", by: "Kavitha Raman", at: TODAY_EARLY, lines: [{ it: "juice", qty: 4, appr: 0 }], st: "Request sent", ticket: null, mgrNote: "", hist: [{ s: "Request sent", who: "Kavitha Raman", t: TODAY_EARLY }] }],
    tkt: [], prq: [], po: [], pord: [], batch: [], bills: [], grn: [], vendors: [],
    contracts: [], tickets: [], productReqs: [], shopAsks: [], sales: [], dayLabels: [],
    // ---- adjustments
    adjustments: [],
  });

  it("carries iso on every document and on every history entry", () => {
    act(() => { applySnapshot(snap() as unknown as Parameters<typeof applySnapshot>[0]); });

    const r = S().req[0];
    expect(r.at).toBe("01:30");            // what the table prints, in the hospital's zone
    expect(r.iso).toBe(TODAY_EARLY);       // what every filter and sort reads
    expect(r.hist[0]).toMatchObject({ t: "01:30", iso: TODAY_EARLY });
  });

  it("keeps the instant when a document that has already been through is mapped again", () => {
    // `fromWireTime` passes an "HH:MM" through unchanged so it is safe to run twice; the
    // stamping must be too. Feeding the store's own row back in (which is what a re-applied
    // document looks like) must not put a clock face where the instant was.
    act(() => { applySnapshot(snap() as unknown as Parameters<typeof applySnapshot>[0]); });
    const once = S().req[0];

    act(() => { applyRequests([once] as unknown as Parameters<typeof applyRequests>[0]); });

    const twice = S().req[0];
    expect(twice.at).toBe("01:30");
    expect(twice.iso).toBe(TODAY_EARLY);
    expect(twice.hist[0]).toMatchObject({ t: "01:30", iso: TODAY_EARLY });
  });
});

describe("the two dashboards read latest off the instant too", () => {
  const bill = (no: string, t: string, iso: string): Dated<Bill> => ({
    no, loc: "coffee", opr: "Kavitha Raman", oprCol: "#0EA5E9", tot: 40, tax: 1.9, t, iso,
    pay: "Cash", lines: [{ it: "juice", qty: 2, rate: 20 }],
  });

  it("puts this morning's bill above last night's on the manager's activity feed", () => {
    act(() => {
      as("manager");
      useApp.setState({
        bills: [bill("CF/1189", "23:30", YESTERDAY_LATE), bill("CF/1190", "01:30", TODAY_EARLY)],
        req: [], tkt: [],
      });
    });

    const html = render(createElement(ManagerDashboard));

    // "Recent activity" is sorted newest-first. On the printed clock face 23:30 led, so the
    // manager's answer to "what just happened" opened with last night.
    expect(html.indexOf("CF/1190")).toBeLessThan(html.indexOf("CF/1189"));
  });

  it("puts this morning's requisition above last night's on the buyer's feed", () => {
    const prq = (id: string, at: string, iso: string): DatedDoc<Requisition> => ({
      id, by: "Murugan S", at, iso, st: "Approved",
      lines: [{ it: "juice", qty: 10, appr: 10, ordered: 10 }], hist: [], note: "",
    });
    act(() => {
      as("buyer");
      // Neither is "Sent", so nothing is drawn above the feed in requisition order - what is
      // being read here is the feed's own sort and nothing else.
      useApp.setState({ prq: [prq("PRQ-2026-0071", "23:30", YESTERDAY_LATE), prq("PRQ-2026-0072", "01:30", TODAY_EARLY)], po: [] });
    });

    const html = render(createElement(BuyerDashboard));

    expect(html.indexOf("PRQ-2026-0072")).toBeLessThan(html.indexOf("PRQ-2026-0071"));
  });
});

describe("a document sorts on the thing the row beside it prints", () => {
  it("puts a fortnight-old order received this morning above a requisition raised last night", () => {
    const po: DatedDoc<PurchaseOrder> = {
      id: "PO-2026-0150", vendor: "VN-001",
      // Raised a fortnight ago, delivered this morning. The row prints `recv`, so it has to
      // sort on it: on `iso` - when the order was *raised* - the delivery the buyer is being
      // shown sank below every requisition of the last two weeks.
      at: "09:15", iso: "2026-08-28T03:45:00.000Z", eta: "11-Sep-2026", recv: "11-Sep-2026",
      st: "Received", lines: [{ it: "juice", qty: 10, rate: 14, recv: 10, rejected: 0,
        src: [{ prq: "PRQ-2026-0070", line: 0, qty: 10 }] }],
      hist: [
        { s: "Ordered", who: "Latha Narayanan", t: "09:15", iso: "2026-08-28T03:45:00.000Z" },
        { s: "Received", who: "Murugan S", t: "07:30", iso: "2026-09-11T02:00:00.000Z" },
      ],
    };
    const prq: DatedDoc<Requisition> = {
      id: "PRQ-2026-0071", by: "Murugan S", at: "23:30", iso: YESTERDAY_LATE, st: "Approved",
      lines: [{ it: "juice", qty: 10, appr: 10, ordered: 10 }], hist: [], note: "",
    };
    act(() => { as("buyer"); useApp.setState({ po: [po], prq: [prq] }); });

    const html = render(createElement(BuyerDashboard));

    expect(html.indexOf("PO-2026-0150")).toBeLessThan(html.indexOf("PRQ-2026-0071"));
  });
});

describe("what the kitchen made today", () => {
  /** Two batches of one product: one baked at 01:30 IST this morning, one at 23:30 IST last
   *  night. Both carry the same UTC date, so a host-day filter counts them together - and a
   *  batch was the one document with no `iso` at all, so nothing could filter them apart. */
  const twoNights = (): Dated<Batch>[] => [
    { id: "BAT-20260911-01", it: "puff", qty: 30, made: 30, at: "01:30", iso: TODAY_EARLY, bb: "09:30" },
    { id: "BAT-20260910-09", it: "puff", qty: 200, made: 200, at: "23:30", iso: YESTERDAY_LATE, bb: "07:30" },
  ];

  it("leaves last night's batch out of 'Units made today' on the kitchen dashboard", () => {
    act(() => { as("prod"); useApp.setState({ batch: twoNights() }); });

    const html = render(createElement(prod.dash));

    // 230 was what this tile read: the whole batch log, under the word "today".
    expect(kpi(html, "Units made today")).toBe("30");
    expect(html).toContain("across <b>1</b> batch");
  });

  it("leaves it off Make & Distribute's batch log, which says today in its own title", () => {
    act(() => { as("prod"); useApp.setState({ batch: twoNights() }); });

    const html = render(createElement(prod.make));

    expect(html).toContain("BAT-20260911-01");
    expect(html).not.toContain("BAT-20260910-09");
    expect(html).toContain("30 units made today");
  });
});
