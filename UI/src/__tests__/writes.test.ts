import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import * as FX from "@rch/contract/fixtures";
import { refetch } from "../api/refetch";
import { setAccessToken } from "../api/session";
import { qty } from "../lib/selectors";
import Pos from "../roles/counter/Pos";
import CounterRequests from "../roles/counter/Requests";
import MakeDistribute from "../roles/prod/MakeDistribute";
import Drawer from "../ui/Drawer";
import "../roles/store/TicketDrawer";          // registers "stkt" on the drawer registry
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

    const ok = await S().submitRequest("Counter runs dry by 4pm", true);

    expect(ok).toBe(true);                                    // the screen resets on this, not on the click
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
    const ok = await S().rejectRequest("REQ-2026-0912", "   ");
    expect(ok).toBe(false);                                   // so the drawer stays open, reason and trims intact
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
      "GET /api/v1/prod-orders": () => json([]),
      "GET /api/v1/tickets": () => json([TKT]),
      "GET /api/v1/stock": () => json(STOCK),
    });
    await S().dispatchOrder("PRD-2026-029");
    expect(hit("POST /api/v1/prod-orders/PRD-2026-029/dispatch")[0].body).toBeUndefined();
    expect(S().drawer).toBeNull();
    expect(S().toast).toBe("TKT-0441 issued — all 2 items of PRD-2026-029 reserved for Snack Kiosk");
    // The board has its own reader since Phase 4, so all three slices come back narrow.
    expect(hit("GET /api/v1/prod-orders")).toHaveLength(1);
    expect(hit("GET /api/v1/snapshot")).toHaveLength(0);
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

const ORDER = { ...FX.seedPord[0], st: "Accepted", hist: [...FX.seedPord[0].hist, { s: "Accepted", who: "Vinoth Prakash", t: "07:41" }] };
const BATCH = {
  id: "BAT-20260904-01", it: "puff", qty: 60, made: 58,
  at: "2026-09-04T01:10:00.000Z", bb: "2026-09-04T13:10:00.000Z", note: "Oven tray dropped",
};

describe("setOrderStatus — POST /prod-orders/:id/status", () => {
  it("names the status in the body and pulls the board back", async () => {
    as("prod");
    serve({
      [`POST /api/v1/prod-orders/${ORDER.id}/status`]: () => json({ result: ORDER, changed: ["pord"], message: `${ORDER.id} — accepted` }),
      "GET /api/v1/prod-orders": () => json([ORDER]),
    });

    await S().setOrderStatus(ORDER.id, "Accepted");

    expect(hit(`POST /api/v1/prod-orders/${ORDER.id}/status`)[0].body).toEqual({ st: "Accepted" });
    expect(hit("GET /api/v1/prod-orders")).toHaveLength(1);
    expect(S().pord.find((o) => o.id === ORDER.id)!.st).toBe("Accepted");
    expect(S().toast).toBe(`${ORDER.id} — accepted`);
  });

  it("keeps a refusal's words and leaves the board where it was", async () => {
    as("prod");
    const before = S().pord.find((o) => o.id === ORDER.id)!.st;
    serve({ [`POST /api/v1/prod-orders/${ORDER.id}/status`]: () => refusal(`${ORDER.id} is new — it cannot go straight to ready`) });

    await S().setOrderStatus(ORDER.id, "Ready");

    expect(S().toast).toBe(`${ORDER.id} is new — it cannot go straight to ready`);
    expect(S().pord.find((o) => o.id === ORDER.id)!.st).toBe(before);
  });
});

describe("makeProduct — POST /batches", () => {
  it("sends what was started and what came good, and reads the batch log and stock back", async () => {
    as("prod");
    serve({
      "POST /api/v1/batches": () => json({ result: BATCH, changed: ["batch", "stock"], message: "BAT-20260904-01 — 58 of 60 Veg puffs yielded (-3.3%), best before 18:40" }),
      "GET /api/v1/batches": () => json([BATCH]),
      "GET /api/v1/stock": () => json(STOCK),
    });

    expect(await S().makeProduct("puff", 60, 58, "Oven tray dropped")).toBe(true);

    expect(hit("POST /api/v1/batches")[0].body).toEqual({ it: "puff", started: 60, made: 58, note: "Oven tray dropped" });
    expect(hit("GET /api/v1/batches")).toHaveLength(1);
    expect(hit("GET /api/v1/stock")).toHaveLength(1);
    expect(S().batch[0].id).toBe("BAT-20260904-01");
    // The wire's instant, in the kitchen's words.
    expect(S().batch[0].bb).toMatch(/^\d{2}:\d{2}/);
    expect(S().toast).toMatch(/yielded/);
  });

  it("leaves the blank boxes out of the body", async () => {
    as("prod");
    serve({
      "POST /api/v1/batches": () => json({ result: { ...BATCH, qty: 10, made: 10, note: undefined }, changed: ["batch", "stock"], message: "BAT-20260904-01 — 10 Veg puffs made, best before 18:40" }),
      "GET /api/v1/batches": () => json([]),
      "GET /api/v1/stock": () => json(STOCK),
    });

    await S().makeProduct("puff", 10);

    expect(hit("POST /api/v1/batches")[0].body).toEqual({ it: "puff", started: 10 });
  });

  it("answers false on a refusal, so the tile can keep what was typed", async () => {
    as("prod");
    const before = S().batch.length;
    serve({ "POST /api/v1/batches": () => refusal("Kitchen is short of Veg filling mix — 1.200 kg left") });

    expect(await S().makeProduct("puff", 200)).toBe(false);

    expect(S().toast).toBe("Kitchen is short of Veg filling mix — 1.200 kg left");
    expect(S().batch).toHaveLength(before);
  });
});

describe("cancelTicket — POST /tickets/:id/cancel", () => {
  const TKT = { ...FX.seedTkt[0], st: "Cancelled" };

  it("sends the reason and pulls the tickets, the holds and the request back", async () => {
    as("store");
    serve({
      [`POST /api/v1/tickets/${TKT.id}/cancel`]: () => json({ result: TKT, changed: ["tkt", "rsv", "req"], message: `${TKT.id} cancelled — ${TKT.req} is approved again and can be issued a new ticket` }),
      "GET /api/v1/tickets": () => json([TKT]),
      "GET /api/v1/stock": () => json(STOCK),
      "GET /api/v1/requests": () => json([]),
    });

    expect(await S().cancelTicket(TKT.id, "The counter closed before the collector came")).toBe(true);

    expect(hit(`POST /api/v1/tickets/${TKT.id}/cancel`)[0].body).toEqual({ reason: "The counter closed before the collector came" });
    expect(S().tkt.find((t) => t.id === TKT.id)!.st).toBe("Cancelled");
    expect(S().toast).toMatch(/cancelled/);
  });

  it("answers false on a refusal, so the drawer can keep the reason", async () => {
    as("store");
    serve({ [`POST /api/v1/tickets/${TKT.id}/cancel`]: () => refusal(`${TKT.id} has already been handed over — the stock is on its way to Floor 3 Coffee Bar`) });

    expect(await S().cancelTicket(TKT.id, "Changed our minds")).toBe(false);

    expect(S().toast).toBe(`${TKT.id} has already been handed over — the stock is on its way to Floor 3 Coffee Bar`);
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

/**
 * A write that is refused must leave the operator's typing where it is. The store says so with
 * its answer — `true` only once the server has taken the write — and the screens reset on that
 * answer and nothing else.
 */
describe("a refusal keeps what the operator typed", () => {
  /** Set a controlled field the way a person does, through React's own value setter. */
  const type = (el: HTMLTextAreaElement | HTMLInputElement, v: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  /** Render the counter's request screen the way the app runs it. */
  function mount() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(MemoryRouter, null, createElement(CounterRequests))); });
    return {
      host,
      button: (starts: string) =>
        [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(starts)),
      note: () => host.querySelector("textarea")!,
      unmount: () => { act(() => { root.unmount(); }); host.remove(); },
    };
  }
  /** The same, for a screen that takes no props of its own. */
  function mountNode(node: Parameters<typeof createElement>[0]) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => { root.render(createElement(MemoryRouter, null, createElement(node))); });
    return {
      host,
      button: (starts: string) =>
        [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").startsWith(starts)),
      field: (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!,
      unmount: () => { act(() => { root.unmount(); }); host.remove(); },
    };
  }
  const settle = async (fn: () => void) => {
    await act(async () => { fn(); await new Promise((r) => { setTimeout(r, 0); }); });
  };

  it("leaves the raise card open, with its note, when the server refuses", async () => {
    as("counter");
    serve({ "POST /api/v1/requests": () => refusal("Refused — Coffee Shop already has REQ-2026-0911 open for Milk 1L") });
    const ui = mount();
    act(() => { ui.button("From inventory")!.click(); });
    act(() => { type(ui.note(), "Milk finished at 09:10"); });

    await settle(() => { ui.button("Submit request")!.click(); });

    expect(S().toast).toBe("Refused — Coffee Shop already has REQ-2026-0911 open for Milk 1L");
    // The card is still open and still carries the note — nothing to retype.
    expect(ui.button("Submit request")).toBeDefined();
    expect(ui.note().value).toBe("Milk finished at 09:10");
    ui.unmount();
  });

  it("clears the card only once the server has taken it", async () => {
    as("counter");
    serve({
      "POST /api/v1/requests": () => json({ result: REQ, changed: ["req"], message: "REQ-2026-0913 sent to the outlet manager — 1 line" }),
      "GET /api/v1/requests": () => json([REQ]),
    });
    const ui = mount();
    act(() => { ui.button("From inventory")!.click(); });
    act(() => { type(ui.note(), "Milk finished at 09:10"); });

    await settle(() => { ui.button("Submit request")!.click(); });

    expect(S().toast).toBe("REQ-2026-0913 sent to the outlet manager — 1 line");
    expect(ui.button("Submit request")).toBeUndefined();   // the card closed behind the answer
    ui.unmount();
  });

  it("locks the button while the request is in flight", async () => {
    as("counter");
    let release!: () => void;
    const inFlight = new Promise<void>((r) => { release = r; });
    fetchMock.mockImplementation(async (u: string, init: RequestInit) => {
      const at = `${init.method} ${String(u).split("?")[0]}`;
      if (at === "POST /api/v1/requests") {
        await inFlight;
        return json({ result: REQ, changed: ["req"], message: "REQ-2026-0913 sent to the outlet manager — 1 line" });
      }
      return json([REQ]);
    });
    const ui = mount();
    act(() => { ui.button("From inventory")!.click(); });

    act(() => { ui.button("Submit request")!.click(); });

    const busy = ui.button("Sending…");
    expect(busy).toBeDefined();
    expect(busy!.disabled).toBe(true);
    act(() => { busy!.click(); });                          // a second tap lands on nothing

    release();
    await act(async () => { await inFlight; await new Promise((r) => { setTimeout(r, 0); }); });
    expect(hit("POST /api/v1/requests")).toHaveLength(1);
    ui.unmount();
  });

  it("leaves the quantity on the make tile when the kitchen is short", async () => {
    as("prod");
    serve({ "POST /api/v1/batches": () => refusal("Kitchen is short of Veg filling mix — 1.200 kg left") });
    const ui = mountNode(MakeDistribute);
    act(() => { type(ui.field("Quantity of Veg puffs to start"), "200"); });

    await settle(() => { ui.button("Make")!.click(); });

    expect(hit("POST /api/v1/batches")[0].body).toEqual({ it: "puff", started: 200 });
    expect(S().toast).toBe("Kitchen is short of Veg filling mix — 1.200 kg left");
    // Nothing to retype: the refusal landed on the kitchen's own typing.
    expect(ui.field("Quantity of Veg puffs to start").value).toBe("200");
    ui.unmount();
  });

  it("locks the make tile while the batch is in flight, so one tray is not baked twice", async () => {
    as("prod");
    let release!: () => void;
    const inFlight = new Promise<void>((r) => { release = r; });
    fetchMock.mockImplementation(async (u: string, init: RequestInit) => {
      const at = `${init.method} ${String(u).split("?")[0]}`;
      if (at === "POST /api/v1/batches") {
        await inFlight;
        return json({ result: BATCH, changed: ["batch", "stock"], message: "BAT-20260904-01 — 58 of 60 Veg puffs yielded (-3.3%), best before 18:40" });
      }
      return at === "GET /api/v1/batches" ? json([BATCH]) : json(STOCK);
    });
    const ui = mountNode(MakeDistribute);
    act(() => { type(ui.field("Quantity of Veg puffs to start"), "60"); });

    act(() => { ui.button("Make")!.click(); });

    // The tile has swapped to its in-flight label and is disabled, so the second tap lands on
    // nothing. (A human's second tap comes after a paint, which is this flush.)
    const busy = ui.button("Making…");
    expect(busy).toBeDefined();
    expect(busy!.disabled).toBe(true);
    act(() => { busy!.click(); });

    release();
    await act(async () => { await inFlight; await new Promise((r) => { setTimeout(r, 0); }); });
    expect(hit("POST /api/v1/batches")).toHaveLength(1);
    // And once it has landed the boxes are the kitchen's again.
    expect(ui.field("Quantity of Veg puffs to start").value).toBe("");
    ui.unmount();
  });

  it("withdraws a ticket nobody collected, and closes the drawer behind it", async () => {
    as("store");
    const tkt = { ...FX.seedTkt[0], st: "Cancelled" };
    serve({
      [`POST /api/v1/tickets/${tkt.id}/cancel`]: () => json({ result: tkt, changed: ["tkt", "rsv"], message: `${tkt.id} cancelled — the stock is free again at Central Store` }),
      "GET /api/v1/tickets": () => json([tkt]),
      "GET /api/v1/stock": () => json(STOCK),
    });
    S().openDrawer("stkt", tkt.id);
    const ui = mountNode(Drawer);

    act(() => { ui.button("Cancel ticket")!.click(); });
    // A cancellation cannot be undone, so the first press only reveals the confirm.
    expect(hit(`POST /api/v1/tickets/${tkt.id}/cancel`)).toHaveLength(0);
    act(() => { type(ui.field(`Why ${tkt.id} is being cancelled`), "The counter closed before the collector came"); });

    await settle(() => { ui.button("Confirm cancellation")!.click(); });

    expect(hit(`POST /api/v1/tickets/${tkt.id}/cancel`)[0].body).toEqual({ reason: "The counter closed before the collector came" });
    expect(S().drawer).toBeNull();
    expect(S().toast).toBe(`${tkt.id} cancelled — the stock is free again at Central Store`);
    ui.unmount();
  });
});

/** Every action's own sentence when the server cannot be reached at all. */
const OFFLINE: [name: string, run: () => Promise<unknown>, sentence: string][] = [
  ["submitRequest", () => { S().setDraft([{ it: "milk", qty: 20 }]); return S().submitRequest("", false); },
    "Could not send the request — check the connection and try again."],
  ["requestFromStore", () => S().requestFromStore("milk", 20),
    "Could not send the request — check the connection and try again."],
  ["cancelRequest", () => S().cancelRequest("REQ-2026-0911"),
    "Could not cancel the request — check the connection and try again."],
  ["approveRequest", () => S().approveRequest("REQ-2026-0911", [12], "Store is tight"),
    "Could not save the approval — check the connection and try again."],
  ["rejectRequest", () => S().rejectRequest("REQ-2026-0911", "Nothing to spare"),
    "Could not save the rejection — check the connection and try again."],
  ["issueTicket", () => S().issueTicket("REQ-2026-0911"),
    "Could not issue the ticket — check the connection and try again."],
  ["handover", () => S().handover("TKT-0440", "418327"),
    "Could not hand the ticket over — check the connection and try again."],
  ["receiveTicket", () => S().receiveTicket("TKT-0440"),
    "Could not receive the ticket — check the connection and try again."],
  ["transferToOutlet", () => S().transferToOutlet("coffee", "kiosk", "chips", 6),
    "Could not send the transfer — check the connection and try again."],
  ["askShop", () => S().askShop("kiosk", "water", 24, "Ran dry"),
    "Could not send the ask — check the connection and try again."],
  ["answerShopAsk", () => S().answerShopAsk("ASK-0060", 6),
    "Could not answer the ask — check the connection and try again."],
  ["declineShopAsk", () => S().declineShopAsk("ASK-0060", "We are short ourselves"),
    "Could not decline the ask — check the connection and try again."],
  ["dispatchOrder", () => S().dispatchOrder("PRD-2026-029"),
    "Could not dispatch the order — check the connection and try again."],
  ["distribute", () => S().distribute("puff", 5, "kiosk"),
    "Could not send it out — check the connection and try again."],
  ["setOrderStatus", () => S().setOrderStatus("PRD-2026-029", "Accepted"),
    "Could not move the order on — check the connection and try again."],
  ["makeProduct", () => S().makeProduct("puff", 10),
    "Could not record the batch — check the connection and try again."],
  ["cancelTicket", () => S().cancelTicket("TKT-0440", "Counter closed"),
    "Could not cancel the ticket — check the connection and try again."],
];

describe("a dropped connection names the write that did not land", () => {
  it.each(OFFLINE)("%s says so in its own words", async (_name, run, sentence) => {
    as("counter");
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await run();
    expect(S().toast).toBe(sentence);
  });
});
