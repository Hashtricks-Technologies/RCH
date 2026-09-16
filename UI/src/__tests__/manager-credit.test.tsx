import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { settlementOverpayMessage } from "@rch/domain";
import Credit from "../roles/manager/Credit";
import { DRAWERS } from "../drawers";
import "../roles/manager/StatementDrawer";        // registers "stmt" on the drawer registry
import { setAccessToken } from "../api/session";
import { useApp } from "../store";
import type { Receivable, Settlement, Statement } from "../types";
import { as, resetStore, S } from "./fixture";

/**
 * The outlet manager's Credit screen, driven against a stubbed server: the three views it holds,
 * the outage line that must never read as a hospital owing nothing, the body a saved rate puts on
 * the wire, the allocation the settle form previews, and the one day a payment can be voided on.
 *
 * The rules themselves belong to the API's own suite (`modules/receivables/receivables.test.ts`);
 * nothing here re-asserts one.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn();
type Stubs = Record<string, () => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make
      ? make()
      : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const calls = () =>
  fetchMock.mock.calls.map((c) => {
    const [u, init] = c as [string, RequestInit];
    return {
      at: `${init.method} ${String(u).split("?")[0]}`,
      body: init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
    };
  });
const hit = (at: string) => calls().filter((c) => c.at === at);

/** Two instants the suite reasons about by name. `TZ=UTC` is pinned for the whole suite, so
 *  "today" is whatever the hospital's calendar says today is when the case runs. */
const TODAY = new Date().toISOString();
const LAST_WEEK = new Date(Date.now() - 7 * 86400000).toISOString();
const A_FORTNIGHT = new Date(Date.now() - 14 * 86400000).toISOString();

const RAO: Receivable = {
  kind: "doctor", id: "DR-118", name: "Dr A. Rao", active: true,
  charged: 8000, settled: 3000, outstanding: 5000, bills: 3, oldest: A_FORTNIGHT, pct: 25, limit: 5000,
};
const KAVITHA: Receivable = {
  kind: "staff", id: "RC-4471", name: "Kavitha Raman", active: false,
  charged: 1200, settled: 1200, outstanding: 0, bills: 0, pct: 0, limit: 3000,
};
const RECEIVABLES = [RAO, KAVITHA];

const PAID_TODAY: Settlement = {
  id: "STL-0007", payer: { kind: "doctor", id: "DR-118", name: "Dr A. Rao" }, amount: 1500,
  mode: "UPI", at: TODAY, by: "Ramesh Kumar", lines: [{ no: "CF/1101", amount: 1500 }],
};
const PAID_LAST_WEEK: Settlement = {
  id: "STL-0004", payer: { kind: "staff", id: "RC-4471", name: "Kavitha Raman" }, amount: 1200,
  mode: "Payroll deduction", at: LAST_WEEK, by: "Ramesh Kumar", lines: [{ no: "CF/1002", amount: 1200 }],
};
const SETTLEMENTS = [PAID_TODAY, PAID_LAST_WEEK];

/** Dr Rao's statement: two bills open, the fortnight-old one first. */
const STATEMENT: Statement = {
  kind: "doctor", id: "DR-118", name: "Dr A. Rao", outstanding: 1200, limit: 5000, pct: 25,
  open: [
    { no: "CF/1190", loc: "coffee", at: LAST_WEEK, total: 900, settled: 0, owed: 900 },
    { no: "CF/1101", loc: "rest", at: A_FORTNIGHT, total: 800, settled: 500, owed: 300 },
  ],
  settlements: [PAID_TODAY],
};

const LISTS: Stubs = {
  "GET /api/v1/receivables": () => json(RECEIVABLES),
  "GET /api/v1/settlements": () => json(SETTLEMENTS),
};

const tick = (ms = 0) => act(async () => { await new Promise((r) => { setTimeout(r, ms); }); });

async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(MemoryRouter, null, el)); });
  await tick();
  return {
    host,
    text: () => host.textContent ?? "",
    button: (label: string, scope: ParentNode = host) =>
      [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => (b.textContent ?? "").trim() === label),
    field: (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!,
    /** The row a label's box sits in, for a table whose every row carries the same Save button. */
    rowOf: (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.closest("tr")!,
    rowsUnder: (heading: string) => {
      const card = [...host.querySelectorAll<HTMLElement>(".card, .fsec")]
        .find((c) => (c.querySelector("h3, h4")?.textContent ?? "") === heading);
      return [...(card?.querySelectorAll<HTMLTableRowElement>("tbody tr") ?? [])]
        .filter((tr) => !tr.querySelector(".empty"));
    },
    press: async (el: HTMLElement | undefined) => {
      expect(el, "no such control").toBeTruthy();
      await act(async () => { el!.click(); });
      await tick();
    },
    type: async (el: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await tick();
    },
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Ui = Awaited<ReturnType<typeof mount>>;

let ui: Ui | undefined;
beforeEach(() => {
  resetStore();
  // `resetStore` does not name these, and `setState` merges - so one case's balances would
  // otherwise still be standing in the next one.
  useApp.setState({ receivables: [], settlements: [], receivablesFailed: false });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  act(() => { as("manager"); setAccessToken("tok"); });
});
afterEach(() => { ui?.unmount(); ui = undefined; vi.unstubAllGlobals(); setAccessToken(null); });

describe("the Credit screen's three views", () => {
  it("opens on the balances, and each tab draws its own", async () => {
    serve(LISTS);
    ui = await mount(createElement(Credit));

    // Who owes what, read on the way in - both lists, through the one action.
    expect(hit("GET /api/v1/receivables")).toHaveLength(1);
    expect(hit("GET /api/v1/settlements")).toHaveLength(1);
    expect(ui.text()).toContain("Dr A. Rao");
    expect(ui.text()).toContain("At the ceiling");
    // A deactivated payer still owes what they owed, so they stay on the list - badged.
    expect(ui.text()).toContain("Kavitha Raman");
    expect(ui.text()).toContain("Deactivated");

    await ui.press(ui.button("Discounts & limits"));
    expect(ui.text()).toContain("What each category is charged");
    expect(ui.text()).toContain("People on their own terms");
    // The demo hospital's one exception, off `PAYER_TERMS`.
    expect(ui.text()).toContain("Dr A. Rao · Cardiology");

    await ui.press(ui.button("Settlements"));
    expect(ui.text()).toContain("STL-0007");
    expect(ui.text()).toContain("Payroll deduction");
  });

  it("says the read failed rather than that nobody owes anything", async () => {
    serve({ "GET /api/v1/receivables": () => json({ error: { code: "internal", message: "no" } }, 500) });
    ui = await mount(createElement(Credit));

    expect(S().receivablesFailed).toBe(true);
    expect(ui.text()).toContain("Could not read who owes what");
    expect(ui.text()).not.toContain("Nobody owes anything");

    // And the same on the settlements view: one read, one outage, both halves of one screen.
    await ui.press(ui.button("Settlements"));
    expect(ui.text()).toContain("Could not read the settlements");
    expect(ui.text()).not.toContain("Nothing has been settled yet");
  });
});

describe("the rate card", () => {
  it("sends the typed rate and ceiling for one category, and leaves a blank ceiling null", async () => {
    serve({
      ...LISTS,
      "PUT /api/v1/payer-terms/class/doctor": () => json({
        result: { cls: "doctor", pct: 30, limit: 7500 },
        changed: ["terms", "receivables"],
        message: "Every doctor now gets 30% off, with a ₹7,500 credit limit",
      }),
      "GET /api/v1/payer-terms": () => json({ classes: [], payers: [] }),
    });
    ui = await mount(createElement(Credit));
    await ui.press(ui.button("Discounts & limits"));

    await ui.type(ui.field("Discount for doctor"), "30");
    await ui.type(ui.field("Credit limit for doctor"), "7500");
    await ui.press(ui.button("Save", ui.rowOf("Discount for doctor")));

    expect(hit("PUT /api/v1/payer-terms/class/doctor")[0].body).toEqual({ pct: 30, limit: 7500 });
    // The server's own sentence, never one of the screen's.
    expect(S().toast).toBe("Every doctor now gets 30% off, with a ₹7,500 credit limit");
  });

  it("refuses to offer Save for a rate the server would turn away, in the server's own words", async () => {
    serve(LISTS);
    ui = await mount(createElement(Credit));
    await ui.press(ui.button("Discounts & limits"));

    await ui.type(ui.field("Discount for doctor"), "120");
    expect(ui.text()).toContain("120% is not a discount; give a rate between 0% and 100%");
    expect(ui.button("Save", ui.rowOf("Discount for doctor"))!.disabled).toBe(true);
    expect(hit("PUT /api/v1/payer-terms/class/doctor")).toHaveLength(0);
  });

  it("takes an exception away by sending both fields null", async () => {
    serve({
      ...LISTS,
      "PUT /api/v1/payer-terms/doctor/DR-118": () => json({
        result: { kind: "doctor", id: "DR-118", name: "Dr A. Rao · Cardiology", pct: null, limit: null },
        changed: ["terms", "receivables"],
        message: "Dr A. Rao · Cardiology is back on the doctor rate",
      }),
      "GET /api/v1/payer-terms": () => json({ classes: [], payers: [] }),
    });
    ui = await mount(createElement(Credit));
    await ui.press(ui.button("Discounts & limits"));

    // Two presses, the way a delete is: the first offers the confirm in place of the row's
    // ordinary actions, the second sends it.
    await ui.press(ui.button("Remove", ui.rowOf("Discount for Dr A. Rao · Cardiology")));
    await ui.press(ui.button("Put back on the category", ui.rowOf("Discount for Dr A. Rao · Cardiology")));

    expect(hit("PUT /api/v1/payer-terms/doctor/DR-118")[0].body).toEqual({ pct: null, limit: null });
  });
});

describe("settlements", () => {
  it("offers Void only on a payment taken today", async () => {
    serve(LISTS);
    ui = await mount(createElement(Credit));
    await ui.press(ui.button("Settlements"));

    const rows = ui.rowsUnder("Payments");
    expect(rows).toHaveLength(2);
    // Newest first, on the instant.
    expect(rows[0].textContent).toContain("STL-0007");
    expect([...rows[0].querySelectorAll("button")].map((b) => b.textContent)).toContain("Void");
    expect([...rows[1].querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Void");
    expect(rows[1].textContent).toContain("Taken on");
  });

  it("holds the void behind a second press and a typed reason", async () => {
    serve({
      ...LISTS,
      "POST /api/v1/settlements/STL-0007/void": () => json({
        result: { ...PAID_TODAY, voided: true, voidReason: "Recorded against the wrong doctor" },
        changed: ["receivables"],
        message: "STL-0007 voided - Dr A. Rao owes ₹6,500.00 again",
      }),
    });
    ui = await mount(createElement(Credit));
    await ui.press(ui.button("Settlements"));

    await ui.press(ui.button("Void"));
    // The button is drawn but locked until the reason is written - no request leaves without one.
    expect(ui.button("Void this payment")!.disabled).toBe(true);
    await ui.type(ui.field("Reason for voiding STL-0007"), "Recorded against the wrong doctor");
    await ui.press(ui.button("Void this payment"));

    expect(hit("POST /api/v1/settlements/STL-0007/void")[0].body).toEqual({ reason: "Recorded against the wrong doctor" });
    expect(S().toast).toBe("STL-0007 voided - Dr A. Rao owes ₹6,500.00 again");
  });
});

describe("the statement drawer", () => {
  const openStatement = () => mount(createElement(DRAWERS.stmt, { id: "doctor:DR-118" }));

  it("previews the oldest bills first, and closes the oldest one outright", async () => {
    serve({ ...LISTS, "GET /api/v1/receivables/doctor/DR-118": () => json(STATEMENT) });
    ui = await openStatement();

    expect(ui.text()).toContain("Dr A. Rao");
    expect(ui.text()).toContain("Doctors");

    await ui.type(ui.host.querySelector<HTMLInputElement>("input[type=number]")!, "500");

    const preview = ui.rowsUnder("What it would close");
    // ₹500 over a ₹300 bill from a fortnight ago and a ₹900 one from last week: the old one is
    // closed, the newer one is the only part payment, and it is the last line.
    expect(preview).toHaveLength(2);
    expect(preview[0].textContent).toContain("CF/1101");
    expect(preview[0].textContent).toContain("Closed");
    expect(preview[1].textContent).toContain("CF/1190");
    expect(preview[1].textContent).toContain("Part paid");
  });

  it("prints the rule's own sentence for an amount bigger than the balance, and sends nothing", async () => {
    serve({ ...LISTS, "GET /api/v1/receivables/doctor/DR-118": () => json(STATEMENT) });
    ui = await openStatement();

    await ui.type(ui.host.querySelector<HTMLInputElement>("input[type=number]")!, "9000");

    expect(ui.text()).toContain(settlementOverpayMessage(9000, 1200, "Dr A. Rao"));
    expect(ui.button("Record the payment")!.disabled).toBe(true);
    expect(hit("POST /api/v1/settlements")).toHaveLength(0);
  });

  it("records the payment, clears the form and reads the statement back", async () => {
    serve({
      ...LISTS,
      "GET /api/v1/receivables/doctor/DR-118": () => json(STATEMENT),
      "POST /api/v1/settlements": () => json({
        result: { ...PAID_TODAY, id: "STL-0008", amount: 500, lines: [{ no: "CF/1101", amount: 300 }, { no: "CF/1190", amount: 200 }] },
        changed: ["receivables"],
        message: "STL-0008 · ₹500.00 taken from Dr A. Rao - ₹700.00 still owing",
      }),
    });
    ui = await openStatement();

    const amount = ui.host.querySelector<HTMLInputElement>("input[type=number]")!;
    await ui.type(amount, "500");
    await ui.press(ui.button("Record the payment"));

    expect(hit("POST /api/v1/settlements")[0].body)
      .toEqual({ kind: "doctor", id: "DR-118", amount: 500, mode: "Cash", note: "" });
    expect(S().toast).toBe("STL-0008 · ₹500.00 taken from Dr A. Rao - ₹700.00 still owing");
    // The form is cleared only because the server took it, and the statement is read again:
    // once on the way in, once after the payment.
    expect(ui.host.querySelector<HTMLInputElement>("input[type=number]")!.value).toBe("");
    expect(hit("GET /api/v1/receivables/doctor/DR-118")).toHaveLength(2);
  });

  it("leaves a refused amount exactly as it was typed", async () => {
    serve({
      ...LISTS,
      "GET /api/v1/receivables/doctor/DR-118": () => json(STATEMENT),
      "POST /api/v1/settlements": () => json({ error: { code: "rule", message: "Refused - ₹500.00 is more than the ₹0.00 Dr A. Rao still owes" } }, 422),
    });
    ui = await openStatement();

    await ui.type(ui.host.querySelector<HTMLInputElement>("input[type=number]")!, "500");
    await ui.press(ui.button("Record the payment"));

    expect(S().toast).toBe("Refused - ₹500.00 is more than the ₹0.00 Dr A. Rao still owes");
    expect(ui.host.querySelector<HTMLInputElement>("input[type=number]")!.value).toBe("500");
  });

  it("says the statement could not be read, and reads it again on a press", async () => {
    serve({ ...LISTS, "GET /api/v1/receivables/doctor/DR-118": () => json({ error: { code: "internal", message: "no" } }, 500) });
    ui = await openStatement();

    expect(ui.text()).toContain("Could not read this account");
    await ui.press(ui.button("Try again"));
    expect(hit("GET /api/v1/receivables/doctor/DR-118")).toHaveLength(2);
  });
});
