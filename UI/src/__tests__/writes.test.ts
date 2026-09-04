import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import * as FX from "@rch/contract/fixtures";
import { refetch } from "../api/refetch";
import { setAccessToken } from "../api/session";
import { qty } from "../lib/selectors";
import Pos from "../roles/counter/Pos";
import { resetStore, S, as } from "./fixture";

/**
 * The five writes the counter and the outlet manager make, as seen from the wire: which
 * route each store action calls, what it puts in the body, and which reads it pulls back
 * afterwards. The rules those routes enforce belong to the server's own suites
 * (pos.test.ts, availability.test.ts, catalog.test.ts) — nothing here re-asserts them.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (message: string, status = 422) => json({ error: { code: "rule", message } }, status);

const fetchMock = vi.fn();
/** Stub by "METHOD /path" — POST /bills and GET /bills are two different endpoints. */
type Stubs = Record<string, () => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return make
      ? Promise.resolve(make())
      : Promise.resolve(json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
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

const STOCK = { stock: { coffee: { juice: 4, milk: 5 } }, rsv: { "coffee:milk": 1 }, ovr: { "coffee:juice": "switched off manually" } };
const BILL = {
  no: "CF/1188", loc: "coffee", opr: "Kavitha Raman", oprCol: "#0EA5E9", tot: 40, tax: 1.9,
  t: "2026-09-04T04:30:00.000Z", pay: "Cash", lines: [{ it: "juice", qty: 2, rate: 20 }],
};
/** A whole snapshot, built from the same fixtures the registries already hold, so the
 *  `hydrateMaster` inside `applySnapshot` restores exactly what was there. */
const snapshot = (prices: { A: Record<string, number>; B: Record<string, number> } = FX.PL) => ({
  user: FX.USERS.find((u) => u.r === "manager"), items: FX.IT, locations: FX.LOC, recipes: FX.RCP,
  users: FX.USERS, stock: {}, rsv: {}, ovr: {}, prices, menu: FX.MENU,
  req: [], tkt: [], prq: [], po: [], pord: [], batch: [], bills: [], grn: [], vendors: [],
  contracts: [], tickets: [], productReqs: [], shopAsks: [], sales: [], dayLabels: [],
});

beforeEach(() => {
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setAccessToken("tok");
});
afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); });

describe("pay — POST /bills", () => {
  it("sends the cart as lines, clears it, and reads stock and bills back", async () => {
    as("counter");
    S().addToCart("coffee", "juice", 2);
    serve({
      "POST /api/v1/bills": () => json({ result: BILL, changed: ["stock", "bills"], message: "Bill CF/1188 · ₹40.00 collected at Floor 3 Coffee Bar" }),
      "GET /api/v1/stock": () => json(STOCK),
      "GET /api/v1/bills": () => json([BILL]),
    });

    await S().pay("coffee", "Cash");

    expect(hit("POST /api/v1/bills")[0].body).toEqual({ loc: "coffee", tender: "Cash", lines: [{ it: "juice", qty: 2 }] });
    expect(S().cart.coffee).toEqual({});
    expect(S().toast).toBe("Bill CF/1188 · ₹40.00 collected at Floor 3 Coffee Bar");
    // Two narrow reads, not a snapshot.
    expect(hit("GET /api/v1/stock")).toHaveLength(1);
    expect(hit("GET /api/v1/bills")).toHaveLength(1);
    expect(hit("GET /api/v1/snapshot")).toHaveLength(0);
    expect(qty(S(), "coffee", "juice")).toBe(4);
    expect(S().bills[0].no).toBe("CF/1188");
    expect(S().bills[0].t).toMatch(/^\d{2}:\d{2}$/);   // ISO -> HH:MM on the way in
  });

  it("names the payer in the body", async () => {
    as("counter");
    S().addToCart("coffee", "juice", 1);
    serve({
      "POST /api/v1/bills": () => json({ result: BILL, changed: ["stock", "bills"], message: "Bill CF/1188 · ₹20.00 posted to Anand Kumar" }),
      "GET /api/v1/stock": () => json(STOCK),
      "GET /api/v1/bills": () => json([BILL]),
    });

    await S().pay("coffee", "Patient bill", { kind: "patient", id: "IP-4471", name: "Anand Kumar" });

    expect(hit("POST /api/v1/bills")[0].body).toEqual({
      loc: "coffee", tender: "Patient bill", payer: { kind: "patient", id: "IP-4471", name: "Anand Kumar" },
      lines: [{ it: "juice", qty: 1 }],
    });
  });

  it("keeps the cart and repeats the server's refusal when the bill is refused", async () => {
    as("counter");
    S().addToCart("coffee", "juice", 3);
    serve({ "POST /api/v1/bills": () => refusal("Only 2 nos of Fresh Juice 200ml left at Floor 3 Coffee Bar") });

    await S().pay("coffee", "Cash");

    expect(S().toast).toBe("Only 2 nos of Fresh Juice 200ml left at Floor 3 Coffee Bar");
    expect(S().cart.coffee).toEqual({ juice: 3 });   // the scan survives, so it can be retried
    expect(calls()).toHaveLength(1);                 // nothing refetched behind a refusal
  });

  it("falls back to its own sentence when the server cannot be reached", async () => {
    as("counter");
    S().addToCart("coffee", "juice", 1);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await S().pay("coffee", "Cash");

    expect(S().toast).toBe("Could not take the bill — check the connection and try again.");
    expect(S().cart.coffee).toEqual({ juice: 1 });
  });

  it("sends nothing at all for an empty cart", async () => {
    as("counter");
    await S().pay("coffee", "Cash");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the bill's own sentence when only the read-back fails", async () => {
    as("counter");
    S().addToCart("coffee", "juice", 1);
    serve({
      "POST /api/v1/bills": () => json({ result: BILL, changed: ["stock", "bills"], message: "Bill CF/1188 · ₹20.00 collected at Floor 3 Coffee Bar" }),
      "GET /api/v1/stock": () => json({ error: { code: "internal", message: "boom" } }, 500),
      "GET /api/v1/bills": () => json([BILL]),
    });

    await S().pay("coffee", "Cash");

    // The bill was taken. Telling the operator it failed would send them round to take it twice.
    expect(S().toast).toBe("Bill CF/1188 · ₹20.00 collected at Floor 3 Coffee Bar — the screen could not be refreshed; reload to see the latest.");
    expect(S().cart.coffee).toEqual({});
  });
});

describe("the till takes one bill per tap", () => {
  /** Render the POS the way the app runs it, and hand back the host to query. */
  function mount() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(MemoryRouter, null, createElement(Pos))); });
    return {
      host,
      button: (starts: string) =>
        [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(starts)),
      unmount: () => { act(() => { root.unmount(); }); host.remove(); },
    };
  }

  it("refuses a second tap while the first bill is still in flight", async () => {
    as("counter");
    S().addToCart("coffee", "juice", 1);
    // Hold POST /bills open so both taps land inside one round trip.
    let release!: () => void;
    const inFlight = new Promise<void>((r) => { release = r; });
    fetchMock.mockImplementation(async (u: string, init: RequestInit) => {
      const at = `${init.method} ${String(u).split("?")[0]}`;
      if (at === "POST /api/v1/bills") {
        await inFlight;
        return json({ result: BILL, changed: ["stock", "bills"], message: "Bill CF/1188 · ₹20.00 collected at Floor 3 Coffee Bar" });
      }
      return at === "GET /api/v1/bills" ? json([BILL]) : json(STOCK);
    });

    const ui = mount();
    expect(ui.button("Pay & print")).toBeDefined();

    act(() => { ui.button("Pay & print")!.click(); });

    // The button has swapped to its in-flight label and is disabled, so the second tap
    // lands on nothing. (A human's second tap comes after a paint, which is this flush.)
    const busy = ui.button("Taking the bill");
    expect(busy).toBeDefined();
    expect(busy!.disabled).toBe(true);
    act(() => { busy!.click(); });

    release();
    await act(async () => { await inFlight; });

    expect(hit("POST /api/v1/bills")).toHaveLength(1);
    ui.unmount();
  });

  it("shows no guessed bill number before the server has issued one", () => {
    as("counter");
    const ui = mount();
    // The number is the server's; nothing local may put one on the card.
    expect(ui.host.textContent).toContain("New bill");
    expect(ui.host.textContent).not.toMatch(/CF\//);
    ui.unmount();
  });
});

describe("toggleAvail — POST /availability/toggle", () => {
  it("posts the location and item and reads only the balances back", async () => {
    as("counter");
    serve({
      "POST /api/v1/availability/toggle": () => json({ result: { loc: "coffee", it: "juice", off: true, reason: "switched off manually" }, changed: ["ovr"], message: "Fresh Juice 200ml switched off at Floor 3 Coffee Bar" }),
      "GET /api/v1/stock": () => json(STOCK),
    });

    await S().toggleAvail("coffee", "juice");

    expect(hit("POST /api/v1/availability/toggle")[0].body).toEqual({ loc: "coffee", it: "juice" });
    expect(S().toast).toBe("Fresh Juice 200ml switched off at Floor 3 Coffee Bar");
    expect(hit("GET /api/v1/stock")).toHaveLength(1);
    expect(hit("GET /api/v1/snapshot")).toHaveLength(0);
    expect(S().ovr["coffee:juice"]).toBe("switched off manually");
  });

  it("repeats a refusal and changes nothing", async () => {
    as("manager");
    serve({ "POST /api/v1/availability/toggle": () => refusal("Central Store is not an outlet") });

    await S().toggleAvail("store", "juice");

    expect(S().toast).toBe("Central Store is not an outlet");
    expect(S().ovr).toEqual({});
    expect(calls()).toHaveLength(1);
  });
});

describe("savePrice — PUT /prices/:list/:it", () => {
  it("puts the price on the named list and takes a fresh snapshot", async () => {
    as("manager");
    serve({
      "PUT /api/v1/prices/B/juice": () => json({ result: { list: "B", it: "juice", price: 18 }, changed: ["prices"], message: "Fresh Juice 200ml priced at ₹18 on list B" }),
      "GET /api/v1/snapshot": () => json(snapshot({ A: FX.PL.A, B: { ...FX.PL.B, juice: 18 } })),
    });

    await S().savePrice("B", "juice", 18);

    expect(hit("PUT /api/v1/prices/B/juice")[0].body).toEqual({ price: 18 });
    expect(S().toast).toBe("Fresh Juice 200ml priced at ₹18 on list B");
    // "prices" has no narrow reader yet, so it costs one snapshot.
    expect(hit("GET /api/v1/snapshot")).toHaveLength(1);
    expect(hit("GET /api/v1/stock")).toHaveLength(0);
    expect(S().prices.B.juice).toBe(18);
  });

  it("hands the MRP refusal to the operator word for word and leaves the list alone", async () => {
    as("manager");
    const before = S().prices.B.juice;
    serve({ "PUT /api/v1/prices/B/juice": () => refusal("Refused — printed MRP of ₹20 is a hard ceiling for Fresh Juice 200ml") });

    await S().savePrice("B", "juice", 99);

    expect(S().toast).toBe("Refused — printed MRP of ₹20 is a hard ceiling for Fresh Juice 200ml");
    expect(S().prices.B.juice).toBe(before);
    expect(calls()).toHaveLength(1);
  });
});

describe("addProduct / removeProduct — the menu routes", () => {
  it("posts a new listing to /menus/:loc/items", async () => {
    as("manager");
    serve({
      "POST /api/v1/menus/coffee/items": () => json({ result: { loc: "coffee", items: ["juice"] }, changed: ["menu"], message: "Fresh Juice 200ml listed at Floor 3 Coffee Bar" }),
      "GET /api/v1/snapshot": () => json(snapshot()),
    });

    await S().addProduct("coffee", "juice");

    expect(hit("POST /api/v1/menus/coffee/items")[0].body).toEqual({ it: "juice" });
    expect(S().toast).toBe("Fresh Juice 200ml listed at Floor 3 Coffee Bar");
    expect(hit("GET /api/v1/snapshot")).toHaveLength(1);
  });

  it("deletes a listing at /menus/:loc/items/:it, with no body", async () => {
    as("manager");
    serve({
      "DELETE /api/v1/menus/coffee/items/chips": () => json({ result: { loc: "coffee", items: [] }, changed: ["menu"], message: "Potato Chips 30g removed from Floor 3 Coffee Bar" }),
      "GET /api/v1/snapshot": () => json(snapshot()),
    });

    await S().removeProduct("coffee", "chips");

    expect(hit("DELETE /api/v1/menus/coffee/items/chips")[0].body).toBeUndefined();
    expect(S().toast).toBe("Potato Chips 30g removed from Floor 3 Coffee Bar");
    expect(hit("GET /api/v1/snapshot")).toHaveLength(1);
  });

  it("repeats the refusal for an item already on the menu", async () => {
    as("manager");
    serve({ "POST /api/v1/menus/coffee/items": () => refusal("Fresh Juice 200ml is already listed at Floor 3 Coffee Bar") });

    await S().addProduct("coffee", "juice");

    expect(S().toast).toBe("Fresh Juice 200ml is already listed at Floor 3 Coffee Bar");
    expect(calls()).toHaveLength(1);
  });
});

describe("refetch — what a write says it changed is what gets read", () => {
  it("answers the three balance slices with one GET /stock", async () => {
    serve({ "GET /api/v1/stock": () => json(STOCK) });
    await refetch(["stock", "rsv", "ovr"]);
    expect(hit("GET /api/v1/stock")).toHaveLength(1);
    expect(hit("GET /api/v1/snapshot")).toHaveLength(0);
    expect(S().rsv["coffee:milk"]).toBe(1);
  });

  it("answers stock and bills with one of each, never a snapshot", async () => {
    serve({ "GET /api/v1/stock": () => json(STOCK), "GET /api/v1/bills": () => json([BILL]) });
    await refetch(["stock", "bills"]);
    expect(calls().map((c) => c.at).sort()).toEqual(["GET /api/v1/bills", "GET /api/v1/stock"]);
  });

  it("falls back to the whole snapshot for a slice with no narrow reader", async () => {
    serve({ "GET /api/v1/snapshot": () => json(snapshot()) });
    await refetch(["menu"]);
    expect(calls().map((c) => c.at)).toEqual(["GET /api/v1/snapshot"]);
  });

  it("takes the snapshot alone when a write touched both kinds", async () => {
    serve({ "GET /api/v1/snapshot": () => json(snapshot()) });
    await refetch(["stock", "prices"]);
    expect(calls().map((c) => c.at)).toEqual(["GET /api/v1/snapshot"]);
  });

  it("reads nothing when a write changed nothing", async () => {
    await refetch([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says the refresh failed, not that the write did", async () => {
    serve({ "GET /api/v1/stock": () => json({ error: { code: "internal", message: "boom" } }, 500) });
    await refetch(["stock"]);
    expect(S().toast).toBe("Saved — but the screen could not be refreshed. Reload to see the latest.");
  });

  it("keeps the caller's own sentence in front when it is given one", async () => {
    serve({ "GET /api/v1/stock": () => json({ error: { code: "internal", message: "boom" } }, 500) });
    await refetch(["stock"], "Veg puffs switched off at Central Kitchen");
    expect(S().toast).toBe("Veg puffs switched off at Central Kitchen — the screen could not be refreshed; reload to see the latest.");
  });
});

/**
 * The request chain, the tickets, the shop asks and the kitchen's two ticket paths, seen the
 * same way: route, body, the sentence that comes back, and which reads follow. The rules
 * themselves belong to requests.test.ts, tickets.test.ts, shopasks.test.ts and
 * production.test.ts — nothing here re-asserts one.
 */
const REQ = {
  id: "REQ-2026-0913", from: "coffee", by: "Kavitha Raman", at: "2026-09-04T04:30:00.000Z",
  lines: [{ it: "milk", qty: 20, appr: 0 }], st: "Request sent", ticket: null, mgrNote: "", hist: [],
};
const TKT = { id: "TKT-0441", req: "REQ-2026-0913", from: "store", to: "coffee", lines: [{ it: "milk", qty: 12 }], st: "Issued", otp: "989089" };
const ASK = { id: "ASK-063", from: "coffee", to: "kiosk", it: "water", qty: 24, st: "Asked", by: "Kavitha Raman", at: "2026-09-04T04:30:00.000Z", note: "Ran dry" };

describe("the request chain — the twelve writes", () => {
  it("submitRequest posts the draft and reads the requests back", async () => {
    as("counter");
    S().setDraft([{ it: "milk", qty: 20 }, { it: "sugar", qty: 4 }]);
    serve({
      "POST /api/v1/requests": () => json({ result: REQ, changed: ["req"], message: "REQ-2026-0913 sent to the outlet manager — 2 lines" }),
      "GET /api/v1/requests": () => json([REQ]),
    });

    await S().submitRequest("Counter runs dry by 4pm", true);

    expect(hit("POST /api/v1/requests")[0].body).toEqual({ lines: [{ it: "milk", qty: 20 }, { it: "sugar", qty: 4 }], note: "Counter runs dry by 4pm", urgent: true });
    expect(S().draft).toEqual([]);
    expect(S().toast).toBe("REQ-2026-0913 sent to the outlet manager — 2 lines");
    expect(hit("GET /api/v1/requests")).toHaveLength(1);
    expect(hit("GET /api/v1/snapshot")).toHaveLength(0);
    expect(S().req.at(-1)!.id).toBe("REQ-2026-0913");
    expect(S().req.at(-1)!.at).toMatch(/^\d{2}:\d{2}$/);       // ISO -> HH:MM on the way in
  });

  it("requestFromStore names the screen it came from", async () => {
    as("counter");
    serve({ "POST /api/v1/requests": () => json({ result: REQ, changed: ["req"], message: "REQ-2026-0913 raised for 20 Milk 1L — with the outlet manager now" }), "GET /api/v1/requests": () => json([REQ]) });
    await S().requestFromStore("milk", 20);
    expect(hit("POST /api/v1/requests")[0].body).toEqual({ lines: [{ it: "milk", qty: 20 }], note: "Raised from Coffee Shop stock screen", urgent: false });
  });

  it("sends nothing at all for an empty draft", async () => {
    as("counter");
    S().setDraft([]);
    await S().submitRequest("", false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(S().toast).toBe("Add at least one line with a quantity");
  });

  it("cancelRequest names the request in the path and sends no body", async () => {
    as("counter");
    serve({ "POST /api/v1/requests/REQ-2026-0911/cancel": () => json({ result: REQ, changed: ["req"], message: "REQ-2026-0911 cancelled" }), "GET /api/v1/requests": () => json([REQ]) });
    await S().cancelRequest("REQ-2026-0911");
    expect(hit("POST /api/v1/requests/REQ-2026-0911/cancel")[0].body).toBeUndefined();
    expect(S().toast).toBe("REQ-2026-0911 cancelled");
    expect(hit("GET /api/v1/requests")).toHaveLength(1);
  });

  it("approveRequest sends the manager's numbers and repeats the server's sentence", async () => {
    as("manager");
    serve({
      "POST /api/v1/requests/REQ-2026-0911/approve": () => json({ result: { request: { ...REQ, id: "REQ-2026-0911", st: "Partially approved" }, trimmed: true }, changed: ["req"], message: "REQ-2026-0911 trimmed — the central store cannot cover the full quantity" }),
      "GET /api/v1/requests": () => json([REQ]),
    });
    await S().approveRequest("REQ-2026-0911", [20], "Store only holds 12 L.");
    expect(hit("POST /api/v1/requests/REQ-2026-0911/approve")[0].body).toEqual({ appr: [20], note: "Store only holds 12 L." });
    expect(S().toast).toBe("REQ-2026-0911 trimmed — the central store cannot cover the full quantity");
  });

  it("hands a rejection refusal to the manager word for word and changes nothing", async () => {
    as("manager");
    const before = S().req.find((r) => r.id === "REQ-2026-0912")!.st;
    serve({ "POST /api/v1/requests/REQ-2026-0912/reject": () => refusal("Give a reason — the counter sees it on the request") });
    await S().rejectRequest("REQ-2026-0912", "   ");
    expect(S().toast).toBe("Give a reason — the counter sees it on the request");
    expect(S().req.find((r) => r.id === "REQ-2026-0912")!.st).toBe(before);
    expect(calls()).toHaveLength(1);
  });

  it("issueTicket reads requests, tickets and balances back", async () => {
    as("store");
    serve({
      "POST /api/v1/requests/REQ-2026-0911/issue-ticket": () => json({ result: { request: { ...REQ, id: "REQ-2026-0911", st: "Ticket issued", ticket: "TKT-0441" }, ticket: TKT }, changed: ["req", "tkt", "rsv"], message: "TKT-0441 issued — Coffee Shop can collect against this ticket" }),
      "GET /api/v1/requests": () => json([REQ]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK),
    });
    await S().issueTicket("REQ-2026-0911");
    expect(calls().map((c) => c.at).sort()).toEqual(["GET /api/v1/requests", "GET /api/v1/stock", "GET /api/v1/tickets", "POST /api/v1/requests/REQ-2026-0911/issue-ticket"]);
    expect(hit("GET /api/v1/snapshot")).toHaveLength(0);
    expect(S().tkt.at(-1)!.id).toBe("TKT-0441");
  });

  it("handover sends the OTP the store keeper typed", async () => {
    as("store");
    serve({
      "POST /api/v1/tickets/TKT-0440/handover": () => json({ result: { ...TKT, id: "TKT-0440", st: "Collected" }, changed: ["tkt", "req", "rsv", "stock"], message: "TKT-0440 handed over — stock is in transit to Coffee Shop" }),
      "GET /api/v1/requests": () => json([REQ]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK),
    });
    await S().handover("TKT-0440", " 418327 ");
    expect(hit("POST /api/v1/tickets/TKT-0440/handover")[0].body).toEqual({ otp: "418327" });
    expect(S().toast).toBe("TKT-0440 handed over — stock is in transit to Coffee Shop");
  });

  it("handover sends an empty body for the supervisor override", async () => {
    as("store");
    serve({
      "POST /api/v1/tickets/TKT-0440/handover": () => json({ result: { ...TKT, id: "TKT-0440", st: "Collected" }, changed: ["tkt", "req", "rsv", "stock"], message: "TKT-0440 handed over on a supervisor override — stock is in transit to Coffee Shop" }),
      "GET /api/v1/requests": () => json([REQ]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK),
    });
    await S().handover("TKT-0440");
    expect(hit("POST /api/v1/tickets/TKT-0440/handover")[0].body).toEqual({});
  });

  it("repeats a wrong-OTP refusal and moves nothing", async () => {
    as("store");
    serve({ "POST /api/v1/tickets/TKT-0440/handover": () => refusal("That OTP does not match TKT-0440. Ask the collector to read it again.") });
    await S().handover("TKT-0440", "000000");
    expect(S().toast).toBe("That OTP does not match TKT-0440. Ask the collector to read it again.");
    expect(S().tkt.find((t) => t.id === "TKT-0440")!.st).toBe("Issued");
    expect(calls()).toHaveLength(1);
  });

  it("receiveTicket closes the drawer once the server has taken it", async () => {
    as("counter");
    S().openDrawer("tkt", "TKT-0440");
    serve({
      "POST /api/v1/tickets/TKT-0440/receive": () => json({ result: { ...TKT, id: "TKT-0440", st: "Received" }, changed: ["tkt", "req", "stock"], message: "Received at Coffee Shop — stock is on the shelf" }),
      "GET /api/v1/requests": () => json([REQ]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK),
    });
    await S().receiveTicket("TKT-0440");
    expect(S().drawer).toBeNull();
    expect(S().toast).toBe("Received at Coffee Shop — stock is on the shelf");
  });

  it("transferToOutlet posts both ends and the quantity", async () => {
    as("counter");
    serve({ "POST /api/v1/transfers": () => json({ result: TKT, changed: ["tkt", "rsv"], message: "TKT-0441 issued — 6 nos reserved at Coffee Shop for Snack Kiosk" }), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK) });
    await S().transferToOutlet("coffee", "kiosk", "chips", 6);
    expect(hit("POST /api/v1/transfers")[0].body).toEqual({ from: "coffee", to: "kiosk", it: "chips", qty: 6 });
  });

  it("askShop names only the shop being asked — the sender's own is the token's", async () => {
    as("counter");
    serve({ "POST /api/v1/shop-asks": () => json({ result: ASK, changed: ["shopAsks"], message: "ASK-063 sent to Snack Kiosk — they decide, not the manager" }), "GET /api/v1/shop-asks": () => json([ASK]) });
    await S().askShop("kiosk", "water", 24, "  Ran dry  ");
    expect(hit("POST /api/v1/shop-asks")[0].body).toEqual({ to: "kiosk", it: "water", qty: 24, note: "Ran dry" });
    expect(hit("GET /api/v1/shop-asks")).toHaveLength(1);
    expect(S().shopAsks[0].id).toBe("ASK-063");
  });

  it("answerShopAsk grants and raises the ticket in one call, not two", async () => {
    as("counter");
    serve({
      "POST /api/v1/shop-asks/ASK-0060/answer": () => json({ result: { ask: { ...ASK, id: "ASK-0060", st: "Sent", grant: 6, ticket: "TKT-0441" }, ticket: TKT }, changed: ["shopAsks", "tkt", "rsv"], message: "ASK-0060 granted — TKT-0441 issued for 6 nos to Snack Kiosk" }),
      "GET /api/v1/shop-asks": () => json([ASK]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK),
    });
    await S().answerShopAsk("ASK-0060", 6);
    expect(hit("POST /api/v1/shop-asks/ASK-0060/answer")[0].body).toEqual({ grant: 6 });
    expect(hit("POST /api/v1/transfers")).toHaveLength(0);       // one endpoint, one ticket
    expect(S().toast).toBe("ASK-0060 granted — TKT-0441 issued for 6 nos to Snack Kiosk");
  });

  it("declineShopAsk trims the reason it sends", async () => {
    as("counter");
    serve({ "POST /api/v1/shop-asks/ASK-0060/decline": () => json({ result: { ...ASK, id: "ASK-0060", st: "Declined", reason: "We are short ourselves" }, changed: ["shopAsks"], message: "ASK-0060 declined" }), "GET /api/v1/shop-asks": () => json([ASK]) });
    await S().declineShopAsk("ASK-0060", "  We are short ourselves  ");
    expect(hit("POST /api/v1/shop-asks/ASK-0060/decline")[0].body).toEqual({ reason: "We are short ourselves" });
  });
});

describe("the kitchen's two ticket paths", () => {
  it("dispatchOrder posts the order id and closes the drawer behind it", async () => {
    as("prod");
    S().openDrawer("pord", "PRD-2026-029");
    serve({
      "POST /api/v1/prod-orders/PRD-2026-029/dispatch": () => json({ result: { order: { id: "PRD-2026-029" }, ticket: TKT }, changed: ["pord", "tkt", "rsv"], message: "TKT-0441 issued — all 2 items of PRD-2026-029 reserved for Snack Kiosk" }),
      "GET /api/v1/snapshot": () => json(snapshot()),
    });
    await S().dispatchOrder("PRD-2026-029");
    expect(hit("POST /api/v1/prod-orders/PRD-2026-029/dispatch")[0].body).toBeUndefined();
    expect(S().drawer).toBeNull();
    expect(S().toast).toBe("TKT-0441 issued — all 2 items of PRD-2026-029 reserved for Snack Kiosk");
    // "pord" has no narrow reader, so the whole set costs one snapshot.
    expect(hit("GET /api/v1/snapshot")).toHaveLength(1);
  });

  it("distribute names the item, the quantity and where it is going", async () => {
    as("prod");
    serve({
      "POST /api/v1/distributions": () => json({ result: TKT, changed: ["tkt", "rsv"], message: "TKT-0441 issued — 5 Veg puff reserved for Snack Kiosk" }),
      "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/stock": () => json(STOCK),
    });
    await S().distribute("puff", 5, "kiosk");
    expect(hit("POST /api/v1/distributions")[0].body).toEqual({ it: "puff", qty: 5, to: "kiosk" });
    expect(S().toast).toBe("TKT-0441 issued — 5 Veg puff reserved for Snack Kiosk");
    expect(hit("GET /api/v1/snapshot")).toHaveLength(0);
  });

  it("repeats a short-kitchen refusal and raises no ticket", async () => {
    as("prod");
    const before = S().tkt.length;
    serve({ "POST /api/v1/distributions": () => refusal("Kitchen has only 5 nos free to promise") });
    await S().distribute("salad", 9999, "kiosk");
    expect(S().toast).toBe("Kitchen has only 5 nos free to promise");
    expect(S().tkt).toHaveLength(before);
    expect(calls()).toHaveLength(1);
  });
});

describe("refetch — the movement slices have narrow readers now", () => {
  it("answers req, tkt and shopAsks without a snapshot", async () => {
    serve({ "GET /api/v1/requests": () => json([REQ]), "GET /api/v1/tickets": () => json([TKT]), "GET /api/v1/shop-asks": () => json([ASK]) });
    await refetch(["req", "tkt", "shopAsks"]);
    expect(calls().map((c) => c.at).sort()).toEqual(["GET /api/v1/requests", "GET /api/v1/shop-asks", "GET /api/v1/tickets"]);
  });

  it("still takes one snapshot when a write touched a slice with no reader", async () => {
    serve({ "GET /api/v1/snapshot": () => json(snapshot()) });
    await refetch(["req", "prices"]);
    expect(calls().map((c) => c.at)).toEqual(["GET /api/v1/snapshot"]);
  });
});
