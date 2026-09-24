import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { DESK_DEFAULTS } from "@rch/domain";
import { refetch } from "../api/refetch";
import { setAccessToken } from "../api/session";
import { DRAWERS } from "../drawers";
import "../registry";
import QrOrders from "../roles/counter/QrOrders";
import CounterBills from "../roles/counter/Bills";
import ManagerBills from "../roles/manager/Bills";
import Shell from "../ui/Shell";
import { useApp } from "../store";
import type { Bill, Dated, Permissions, QrOrder } from "../types";
import { as, resetStore, S, userOf } from "./fixture";

/**
 * The counter's QR orders: the slice on the wire and its read-back, the `qrOrders` reader's
 * guard, the queue screen (lanes, the one next step, the pause switch, view only, the order),
 * the bell row, and the QR badge and refund controls on the bills. Which step may follow, who
 * may pause and when a refund is sent are the API's rules (`apps/api/src/modules/qr`).
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (message: string, status = 422) => json({ error: { code: "rule", message } }, status);

const fetchMock = vi.fn();
type Stubs = Record<string, (init: RequestInit) => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make
      ? make(init)
      : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const hit = (at: string) => fetchMock.mock.calls.filter((c) => {
  const [u, init] = c as [string, RequestInit];
  return `${init.method} ${String(u).split("?")[0]}` === at;
});
const bodyOf = (at: string, i = 0) => JSON.parse(String((hit(at)[i][1] as RequestInit).body ?? "null")) as unknown;

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const order = (over: Partial<QrOrder> = {}): QrOrder => ({
  id: "QO-2026-0001", loc: "coffee", label: "Table 4", mode: "pickup", spot: "", status: "Paid",
  name: "Asha Menon", phone: "9876543210",
  lines: [{ it: "juice", name: "Fresh Juice", qty: 2, rate: 20, amount: 40 }],
  total: 40, tax: 1.9, discount: 0, at: ago(12), paidAt: ago(11), billNo: "CF/1204", refund: null,
  ...over,
});
const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, opens: "00:00", closes: "23:59" }));
const queue = (orders: QrOrder[], paused = false, hours = [{ loc: "coffee", days: ALL_DAY }]) =>
  json({ orders, paused: { coffee: paused }, hours });

function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => { root.render(createElement(MemoryRouter, null, el)); });
  return { host, unmount: () => { act(() => { root.unmount(); }); host.remove(); } };
}
const settle = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); }); };
const buttons = (root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string, root: ParentNode = document) => buttons(root).find((b) => b.textContent?.trim() === label);
const lane = (host: HTMLElement, title: string) =>
  [...host.querySelectorAll<HTMLElement>("section.kan-col")].find((s) => s.getAttribute("aria-label")?.startsWith(`${title} - `))!;
const idsIn = (el: ParentNode) => [...el.querySelectorAll<HTMLElement>("[data-order]")].map((c) => c.dataset.order);

beforeEach(() => {
  localStorage.clear();
  resetStore();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  setAccessToken("tok");
});
afterEach(() => { vi.unstubAllGlobals(); setAccessToken(null); localStorage.clear(); });

describe("the store's QR order calls", () => {
  it("loads the queue, the pause switches and the hours, and marks a failed load", async () => {
    as("counter");
    serve({ "GET /api/v1/qr-orders": () => queue([order()], true) });
    expect(await S().loadQrOrders()).toBe(true);
    expect(S().qrOrders.map((o) => o.id)).toEqual(["QO-2026-0001"]);
    expect(S().qrPaused).toEqual({ coffee: true });
    expect(S().qrHours[0].loc).toBe("coffee");
    expect(S().qrOrdersFailed).toBe(false);

    serve({});
    expect(await S().loadQrOrders()).toBe(false);
    expect(S().qrOrdersFailed).toBe(true);
    expect(S().qrOrders).toHaveLength(1);
  });

  it("moves an order on with the server's sentence and reads the queue back", async () => {
    as("counter");
    serve({
      "POST /api/v1/qr-orders/QO-2026-0001/status": () => json({ result: order({ status: "Preparing" }), changed: ["qrOrders"], message: "QO-2026-0001 is being prepared." }),
      "GET /api/v1/qr-orders": () => queue([order({ status: "Preparing" })]),
    });
    expect(await S().setQrOrderStatus("QO-2026-0001", "Preparing")).toBe(true);
    expect(bodyOf("POST /api/v1/qr-orders/QO-2026-0001/status")).toEqual({ to: "Preparing" });
    expect(S().toast).toBe("QO-2026-0001 is being prepared.");
    expect(hit("GET /api/v1/qr-orders")).toHaveLength(1);
    expect(S().qrOrders[0].status).toBe("Preparing");

    serve({ "POST /api/v1/qr-orders/QO-2026-0001/status": () => refusal("QO-2026-0001 is already Ready - it cannot go back to Preparing.") });
    expect(await S().setQrOrderStatus("QO-2026-0001", "Preparing")).toBe(false);
    expect(S().toast).toBe("QO-2026-0001 is already Ready - it cannot go back to Preparing.");

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await S().setQrOrderStatus("QO-2026-0001", "Ready")).toBe(false);
    expect(S().toast).toContain("Could not move the QR order on");
  });

  it("pauses and resumes an outlet, and retries a refund", async () => {
    as("counter");
    serve({
      "PUT /api/v1/outlets/coffee/qr-pause": (init) => json({
        result: { loc: "coffee", paused: (JSON.parse(String(init.body)) as { paused: boolean }).paused },
        changed: ["qrOrders"], message: "QR ordering is paused at Coffee Shop.",
      }),
      "GET /api/v1/qr-orders": () => queue([], true),
      "POST /api/v1/qr-refunds/RF-1/retry": () => json({
        result: { id: "RF-1", status: "Pending", reason: "void", amount: 40, attempts: 0 },
        changed: ["bills", "qrOrders"], message: "The refund of ₹40.00 on CF/1204 is queued again.",
      }),
      "GET /api/v1/bills": () => json([]),
    });
    expect(await S().setQrPause("coffee", true)).toBe(true);
    expect(bodyOf("PUT /api/v1/outlets/coffee/qr-pause")).toEqual({ paused: true });
    expect(S().qrPaused.coffee).toBe(true);

    expect(await S().retryQrRefund("RF-1")).toBe(true);
    expect(S().toast).toBe("The refund of ₹40.00 on CF/1204 is queued again.");
    expect(hit("GET /api/v1/bills")).toHaveLength(1);

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await S().setQrPause("coffee", false)).toBe(false);
    expect(S().toast).toContain("Could not resume QR ordering");
    expect(await S().retryQrRefund("RF-1")).toBe(false);
    expect(S().toast).toContain("Could not retry the refund");
  });

  it("reads a qrOrders notice back only for a session holding QR orders", async () => {
    serve({ "GET /api/v1/qr-orders": () => queue([order()]) });
    as("manager");
    await refetch(["qrOrders"]);
    expect(hit("GET /api/v1/qr-orders")).toHaveLength(1);

    fetchMock.mockClear();
    as("store");
    await refetch(["qrOrders"]);
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => { useApp.setState({ user: { ...userOf("counter"), admin: true } }); });
    await refetch(["qrOrders"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the QR orders screen", () => {
  it("lays the orders out by lane, oldest first on the instant, with the new ones marked", async () => {
    as("counter");
    // 22:00 IST yesterday sorts before 09:00 IST today, though "22:00" > "09:00" as text.
    const late = order({ id: "QO-2026-0002", paidAt: "2026-09-23T16:30:00.000Z" });
    const early = order({ id: "QO-2026-0003", paidAt: "2026-09-24T03:30:00.000Z" });
    serve({ "GET /api/v1/qr-orders": () => queue([
      early, late,
      order({ id: "QO-2026-0004", status: "Preparing" }),
      order({ id: "QO-2026-0005", status: "Ready" }),
      order({ id: "QO-2026-0006", status: "Out for delivery", mode: "deliver", label: "Ward 3B", spot: "Bed 12" }),
      order({ id: "QO-2026-0007", status: "Collected" }),
      order({ id: "QO-2026-0008", status: "Refunded", billNo: undefined, refund: { id: "RF-2", status: "Processed", reason: "unfulfillable", amount: 40, attempts: 1 } }),
      order({ id: "QO-2026-0009", status: "Paid", loc: "kiosk" }),
    ]) });
    const m = mount(createElement(QrOrders));
    await settle();

    expect(idsIn(lane(m.host, "New"))).toEqual(["QO-2026-0002", "QO-2026-0003"]);
    expect(lane(m.host, "New").querySelectorAll(".qr-new")).toHaveLength(2);
    expect(idsIn(lane(m.host, "Preparing"))).toEqual(["QO-2026-0004"]);
    expect(idsIn(lane(m.host, "Ready / Out for delivery"))).toEqual(["QO-2026-0005", "QO-2026-0006"]);
    expect(m.host.textContent).toContain("Deliver to Bed 12");
    expect(m.host.textContent).toContain("Pickup");
    expect(m.host.textContent).toContain("Paid online");
    expect(m.host.querySelector('a[href="tel:9876543210"]')).toBeTruthy();
    // Another counter's order is not this counter's work.
    expect(m.host.textContent).not.toContain("QO-2026-0009");

    // Done is collapsed until asked for, and a refunded order wears its refund.
    expect(m.host.textContent).toContain("Done today (2)");
    expect(m.host.textContent).not.toContain("QO-2026-0007");
    act(() => { button("Show", m.host)!.click(); });
    expect(m.host.textContent).toContain("QO-2026-0007");
    expect(m.host.textContent).toContain("Refund processed");
    m.unmount();
  });

  it("offers exactly one next step per order, fired without a form", async () => {
    as("counter");
    const orders = [
      order({ id: "QO-2026-0011" }),
      order({ id: "QO-2026-0012", status: "Preparing", mode: "deliver", spot: "Bed 4" }),
      order({ id: "QO-2026-0013", status: "Ready" }),
    ];
    serve({
      "GET /api/v1/qr-orders": () => queue(orders),
      "POST /api/v1/qr-orders/QO-2026-0011/status": () => json({ result: orders[0], changed: ["qrOrders"], message: "QO-2026-0011 is being prepared." }),
      "POST /api/v1/qr-orders/QO-2026-0012/status": () => json({ result: orders[1], changed: ["qrOrders"], message: "QO-2026-0012 is on its way." }),
      "POST /api/v1/qr-orders/QO-2026-0013/status": () => json({ result: orders[2], changed: ["qrOrders"], message: "QO-2026-0013 was collected." }),
    });
    const m = mount(createElement(QrOrders));
    await settle();
    const card = (id: string) => m.host.querySelector<HTMLElement>(`[data-order="${id}"]`)!;
    const steps = (id: string) => buttons(card(id)).filter((b) => !b.getAttribute("aria-label")?.startsWith("Open bill")).map((b) => b.textContent);
    expect(steps("QO-2026-0011")).toEqual(["Start preparing"]);
    expect(steps("QO-2026-0012")).toEqual(["Out for delivery"]);
    expect(steps("QO-2026-0013")).toEqual(["Collected"]);

    act(() => { button("Start preparing", card("QO-2026-0011"))!.click(); });
    await settle();
    expect(bodyOf("POST /api/v1/qr-orders/QO-2026-0011/status")).toEqual({ to: "Preparing" });
    act(() => { button("Out for delivery", card("QO-2026-0012"))!.click(); });
    await settle();
    expect(bodyOf("POST /api/v1/qr-orders/QO-2026-0012/status")).toEqual({ to: "Out for delivery" });
    act(() => { button("Collected", card("QO-2026-0013"))!.click(); });
    await settle();
    expect(bodyOf("POST /api/v1/qr-orders/QO-2026-0013/status")).toEqual({ to: "Collected" });
    expect(S().toast).toBe("QO-2026-0013 was collected.");

    // The bill number opens the bill.
    act(() => { m.host.querySelector<HTMLButtonElement>('button[aria-label="Open bill CF/1204"]')!.click(); });
    expect(S().drawer).toEqual({ t: "cbill", id: "CF/1204" });
    m.unmount();
  });

  it("pauses this counter's QR ordering from the head, and says when it is open", async () => {
    as("counter");
    let paused = false;
    serve({
      "GET /api/v1/qr-orders": () => queue([], paused),
      "PUT /api/v1/outlets/coffee/qr-pause": () => { paused = true; return json({ result: { loc: "coffee", paused: true }, changed: ["qrOrders"], message: "QR ordering is paused at Coffee Shop." }); },
    });
    const m = mount(createElement(QrOrders));
    await settle();
    expect(m.host.textContent).toContain("Taking orders");
    expect(m.host.querySelector("[data-qr-status]")!.textContent).toMatch(/QR ordering (open until|closed at) 23:59/);

    const sw = m.host.querySelector<HTMLButtonElement>('button[aria-label="QR ordering"]')!;
    expect(sw.getAttribute("aria-pressed")).toBe("true");
    act(() => { sw.click(); });
    await settle();
    expect(bodyOf("PUT /api/v1/outlets/coffee/qr-pause")).toEqual({ paused: true });
    expect(m.host.textContent).toContain("Paused");
    expect(m.host.querySelector("[data-qr-status]")!.textContent).toBe("QR ordering is paused at this counter.");
    m.unmount();
  });

  it("says a day with no hours is closed, and shows an outage rather than an empty queue", async () => {
    as("counter");
    serve({ "GET /api/v1/qr-orders": () => queue([], false, []) });
    const m = mount(createElement(QrOrders));
    await settle();
    expect(m.host.querySelector("[data-qr-status]")!.textContent).toBe("QR ordering is closed today.");
    expect(m.host.textContent).toContain("No QR order has been finished today.");
    m.unmount();

    serve({});
    const n = mount(createElement(QrOrders));
    await settle();
    expect(n.host.textContent).toContain("The QR orders could not be read");
    n.unmount();
  });

  it("is read-only at view: the badge, no step buttons, the switch shut", async () => {
    as("manager");
    serve({ "GET /api/v1/qr-orders": () => queue([order(), order({ id: "QO-2026-0021", loc: "rest", status: "Preparing" })]) });
    const m = mount(createElement(QrOrders));
    await settle();
    expect([...m.host.querySelectorAll(".pill")].some((p) => p.textContent === "View only")).toBe(true);
    expect(button("Start preparing", m.host)).toBeUndefined();
    expect(button("Mark ready", m.host)).toBeUndefined();
    // A manager reading every outlet sees both, each named by its outlet where it is not their own.
    expect(idsIn(m.host)).toEqual(expect.arrayContaining(["QO-2026-0001", "QO-2026-0021"]));
    expect(m.host.textContent).toContain("Table 4 · Coffee Shop");
    expect(m.host.querySelector<HTMLButtonElement>('button[aria-label="QR ordering"]')!.disabled).toBe(true);
    m.unmount();
  });
});

describe("the bell", () => {
  it("counts the paid orders nobody has started at this counter, and opens the queue", async () => {
    as("counter");
    serve({ "GET /api/v1/qr-orders": () => queue([
      order({ id: "QO-2026-0031" }), order({ id: "QO-2026-0032" }),
      order({ id: "QO-2026-0033", status: "Preparing" }), order({ id: "QO-2026-0034", loc: "kiosk" }),
    ]) });
    const m = mount(createElement(Shell, null, createElement("p", null, "screen")));
    await settle();
    expect(hit("GET /api/v1/qr-orders")).toHaveLength(1);
    act(() => { m.host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click(); });
    const row = [...m.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.includes("New QR orders"));
    expect(row?.querySelector(".pn")?.textContent).toBe("2");
    m.unmount();
  });

  it("has no QR row for a role that only reads them, nor a read for one without them", async () => {
    as("manager");
    serve({ "GET /api/v1/qr-orders": () => queue([order({ loc: "rest" })]) });
    const m = mount(createElement(Shell, null, createElement("p", null, "screen")));
    await settle();
    act(() => { m.host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click(); });
    expect(m.host.textContent).not.toContain("New QR orders");
    m.unmount();

    fetchMock.mockClear();
    as("store");
    const n = mount(createElement(Shell, null, createElement("p", null, "screen")));
    await settle();
    expect(hit("GET /api/v1/qr-orders")).toHaveLength(0);
    n.unmount();
  });
});

describe("QR bills", () => {
  const qrBill = (over: Partial<Dated<Bill>> = {}): Dated<Bill> => ({
    no: "CF/1204", loc: "coffee", opr: "QR Orders", oprCol: "", tot: 40, tax: 1.9, t: "10:15", iso: ago(5),
    pay: "Online", lines: [{ it: "juice", qty: 2, rate: 20 }], src: "qr", qo: "QO-2026-0001", refund: null,
    ...over,
  } as Dated<Bill>);
  const put = (b: Dated<Bill>) => act(() => { useApp.setState((s) => ({ bills: [b, ...s.bills] })); });
  const withVoid = (on: boolean): Permissions => {
    const p = JSON.parse(JSON.stringify(DESK_DEFAULTS.manager.perms)) as Permissions;
    p.a = on ? p.a : p.a.filter((a) => a !== "void_bill");
    return p;
  };

  it("badges a QR bill on the counter's list and on the manager's", () => {
    as("counter");
    put(qrBill());
    const c = mount(createElement(CounterBills));
    const row = [...c.host.querySelectorAll("tr")].find((r) => r.textContent?.includes("CF/1204"))!;
    expect([...row.querySelectorAll(".pill")].map((p) => p.textContent)).toContain("QR");
    const till = [...c.host.querySelectorAll("tr")].find((r) => r.textContent && !r.textContent.includes("CF/1204") && r.querySelector(".mono"));
    expect([...(till?.querySelectorAll(".pill") ?? [])].map((p) => p.textContent)).not.toContain("QR");
    c.unmount();

    as("manager");
    const m = mount(createElement(ManagerBills));
    const mrow = [...m.host.querySelectorAll("tr")].find((r) => r.textContent?.includes("CF/1204"))!;
    expect([...mrow.querySelectorAll(".pill")].map((p) => p.textContent)).toContain("QR");
    m.unmount();
  });

  it("names the order in the drawer, pills the refund, and retries a failed one for Void bill alone", async () => {
    as("counter");
    put(qrBill({ voided: true, refund: { id: "RF-1", status: "Failed" } }));
    const c = mount(createElement(DRAWERS.cbill, { id: "CF/1204" }));
    expect(c.host.textContent).toContain("QO-2026-0001");
    expect(c.host.textContent).toContain("Refund failed");
    expect(button("Retry refund")).toBeUndefined();
    c.unmount();

    act(() => { useApp.setState({ user: { ...userOf("manager"), perms: withVoid(false) } }); });
    const n = mount(createElement(DRAWERS.cbill, { id: "CF/1204" }));
    expect(button("Retry refund")).toBeUndefined();
    n.unmount();

    act(() => { useApp.setState({ user: { ...userOf("manager"), perms: withVoid(true) } }); });
    serve({
      "POST /api/v1/qr-refunds/RF-1/retry": () => json({ result: { id: "RF-1", status: "Pending", reason: "void", amount: 40, attempts: 0 }, changed: ["bills"], message: "The refund of ₹40.00 on CF/1204 is queued again." }),
      "GET /api/v1/bills": () => json([]),
    });
    const m = mount(createElement(DRAWERS.cbill, { id: "CF/1204" }));
    act(() => { button("Retry refund")!.click(); });
    await settle();
    expect(hit("POST /api/v1/qr-refunds/RF-1/retry")).toHaveLength(1);
    expect(S().toast).toBe("The refund of ₹40.00 on CF/1204 is queued again.");
    m.unmount();
  });

  it("offers no retry on a refund that has not failed", () => {
    as("manager");
    put(qrBill({ voided: true, refund: { id: "RF-1", status: "Sent" } }));
    const m = mount(createElement(DRAWERS.cbill, { id: "CF/1204" }));
    expect(m.host.textContent).toContain("Refund sent");
    expect(button("Retry refund")).toBeUndefined();
    m.unmount();
  });
});
