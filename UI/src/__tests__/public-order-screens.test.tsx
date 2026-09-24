import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { PublicQrOrder } from "@rch/contract";
import { money, pausedRefusal, customerPhoneRefusal, QR_STATUS_WORDS } from "@rch/domain";
import OrderApp from "../pages/public/OrderApp";
import { closedBanner } from "../pages/public/Menu";
import { istStamp, refundWords, whereWords } from "../pages/public/OrderStatus";
import { resetPublicOrder, usePublicOrder } from "../store/publicOrder";
import { SECRET, TOKEN, created, json, menuOf, orderOf, refusal } from "./publicFixture";

/**
 * The public QR ordering page's screens: the menu (sold out, closed, paused, search, empty), the
 * checkout sheet (its field checks, a refusal shown as sent, the sheet's keyboard), and the status
 * page in each state an order can be in.
 */

const fetchMock = vi.fn();
type Stubs = Record<string, () => Response>;
function serve(stubs: Stubs): void {
  fetchMock.mockImplementation((u: string, init: RequestInit) => {
    const make = stubs[`${init.method} ${String(u).split("?")[0]}`];
    return Promise.resolve(make ? make() : json({ error: { code: "internal", message: `no stub for ${init.method} ${u}` } }, 500));
  });
}
const MENU = `GET /api/v1/public/qr/${TOKEN}`;
const PLACE = `POST /api/v1/public/qr/${TOKEN}/orders`;
const STATUS = "GET /api/v1/public/orders/QO-2026-0042";

const settle = () => act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });

async function mount(url: string) {
  window.history.replaceState(null, "", url);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(OrderApp)); });
  await settle();
  const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
  return {
    host, q,
    text: () => host.textContent ?? "",
    button: (label: string) => [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").includes(label)),
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
}
type Ui = Awaited<ReturnType<typeof mount>>;
let ui: Ui | undefined;

const typeIn = (el: HTMLInputElement, v: string) => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = (el: Element | undefined) => { act(() => { (el as HTMLElement).click(); }); };

beforeEach(() => {
  resetPublicOrder();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);   // jsdom has none
  localStorage.clear();
  window.Razorpay = class { open() { /* the checkout would take over the screen here */ } } as unknown as typeof window.Razorpay;
});
afterEach(() => {
  ui?.unmount();
  ui = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.Razorpay;
});

describe("the menu", () => {
  it("draws the outlet, the code, prices and a sold-out row", async () => {
    serve({ [MENU]: () => json(menuOf()) });
    ui = await mount(`/order/${TOKEN}`);
    expect(ui.q("h1")?.textContent).toBe("Coffee Shop");
    expect(ui.text()).toContain("Table 4");
    expect(ui.text()).toContain("Collect at the counter");
    expect(ui.text()).toContain(money(20));
    expect(ui.text()).toContain(`MRP ${money(50)}`);
    const out = [...ui.host.querySelectorAll(".qo-item")].find((r) => r.textContent?.includes("Orange Juice"))!;
    expect(out.className).toContain("is-out");
    expect(out.textContent).toContain("Sold out");
    expect(out.textContent).toContain("Sold out for today");
    expect(out.querySelector("button")).toBeNull();
    expect(document.title).toBe("Coffee Shop - order");
    // The photo is lazy and from the item's own address; the one with none gets the placeholder.
    const img = ui.q<HTMLImageElement>("img.qo-thumb")!;
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("src")).toBe(`/api/v1/items/cake/image/${"a".repeat(64)}`);
    act(() => { img.dispatchEvent(new Event("error")); });
    expect(ui.q("img.qo-thumb")).toBeNull();
  });

  it("adds to the cart and shows the bar", async () => {
    serve({ [MENU]: () => json(menuOf()) });
    ui = await mount(`/order/${TOKEN}`);
    expect(ui.q(".qo-bar")).toBeNull();
    click(ui.button("Add Masala Tea"));
    click(ui.button("One more Masala Tea"));
    expect(ui.q(".qo-bar")?.textContent).toContain("2 items");
    expect(ui.q(".qo-bar")?.textContent).toContain(money(40));
    click(ui.button("One less Masala Tea"));
    expect(ui.q(".qo-bar")?.textContent).toContain("1 item");
    // Plum Cake stops at its three.
    click(ui.button("Add Plum Cake"));
    click(ui.button("One more Plum Cake"));
    click(ui.button("One more Plum Cake"));
    expect((ui.button("One more Plum Cake") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says why it is closed, with today's hours, and takes nothing", async () => {
    const open = { open: false, why: "QR ordering opens at 08:00 today.", today: { opens: "08:00", closes: "20:00" } };
    serve({ [MENU]: () => json(menuOf({ open })) });
    ui = await mount(`/order/${TOKEN}`);
    expect(ui.q(".qo-banner")?.textContent).toContain("Not taking orders right now");
    expect(ui.q(".qo-banner")?.textContent).toContain("QR ordering opens at 08:00 today. Today's ordering hours are 08:00 to 20:00.");
    expect((ui.button("Add Masala Tea") as HTMLButtonElement).disabled).toBe(true);
    expect(closedBanner(menuOf({ open: { open: false, today: null } }))?.body).toBe("QR ordering is closed.");
  });

  it("says the counter has paused it, in the domain's words", async () => {
    serve({ [MENU]: () => json(menuOf({ paused: true })) });
    ui = await mount(`/order/${TOKEN}`);
    expect(ui.q(".qo-banner")?.textContent).toContain(pausedRefusal("Coffee Shop"));
  });

  it("searches, and says when nothing matches or nothing is on", async () => {
    serve({ [MENU]: () => json(menuOf()) });
    ui = await mount(`/order/${TOKEN}`);
    typeIn(ui.q<HTMLInputElement>("input[type=search]")!, "cake");
    expect(ui.host.querySelectorAll(".qo-item")).toHaveLength(1);
    typeIn(ui.q<HTMLInputElement>("input[type=search]")!, "pizza");
    expect(ui.text()).toContain("Nothing on the menu matches “pizza”.");
    ui.unmount();
    resetPublicOrder();
    serve({ [MENU]: () => json(menuOf({ items: [] })) });
    ui = await mount(`/order/${TOKEN}`);
    expect(ui.text()).toContain("Nothing is on the menu right now.");
  });

  it("answers an unknown code, an outage and a bad path", async () => {
    serve({ [MENU]: () => json({ error: { code: "not_found", message: "Not found." } }, 404) });
    ui = await mount(`/order/${TOKEN}`);
    expect(ui.text()).toContain("This code isn't working");
    ui.unmount();
    resetPublicOrder();
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    ui = await mount(`/order/${TOKEN}`);
    expect(ui.text()).toContain("Could not load the menu");
    serve({ [MENU]: () => json(menuOf()) });
    click(ui.button("Try again"));
    await settle();
    expect(ui.q("h1")?.textContent).toBe("Coffee Shop");
    ui.unmount();
    ui = await mount("/order/");
    expect(ui.text()).toContain("This code isn't working");
  });
});

describe("the checkout sheet", () => {
  async function openSheet(menu = menuOf()) {
    serve({ [MENU]: () => json(menu) });
    ui = await mount(`/order/${TOKEN}`);
    click(ui.button("Add Masala Tea"));
    click(ui.button("Review order"));
    return ui.q<HTMLDivElement>("[role=dialog]")!;
  }

  it("opens as a dialog with the keyboard on its title, and closes on Escape", async () => {
    const d = await openSheet();
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.id).toBe("qo-sheet-title");
    act(() => { d.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(ui!.q("[role=dialog]")).toBeNull();
  });

  it("checks the name and phone before sending anything", async () => {
    const d = await openSheet();
    const u = ui!;
    const phone = d.querySelector<HTMLInputElement>("#qo-phone")!;
    expect(phone.getAttribute("inputmode")).toBe("tel");
    expect(phone.getAttribute("autocomplete")).toBe("tel");
    expect(d.querySelector("#qo-detail")).toBeNull();
    typeIn(phone, "12345");
    await act(async () => { d.querySelector("form")!.requestSubmit(); });
    await settle();
    expect(u.text()).toContain(customerPhoneRefusal("12345"));
    expect(u.text()).toContain("Enter your name");
    expect(document.activeElement?.id).toBe("qo-name");
    expect(fetchMock.mock.calls.filter(([x]) => String(x).includes("/orders"))).toHaveLength(0);
  });

  it("shows a refusal as sent and keeps what was typed", async () => {
    const d = await openSheet(menuOf({ qr: { label: "Ward 3B", mode: "deliver" } }));
    const u = ui!;
    typeIn(d.querySelector<HTMLInputElement>("#qo-name")!, "Asha");
    typeIn(d.querySelector<HTMLInputElement>("#qo-phone")!, "9843022118");
    typeIn(d.querySelector<HTMLInputElement>("#qo-detail")!, "Bed 12");
    expect(u.text()).toContain("Bed / seat / room (optional)");
    serve({ [PLACE]: () => refusal("Masala Tea has just sold out - take it off your order and try again.") });
    expect(u.button("Pay")?.textContent).toBe(`Pay ${money(20)}`);
    await act(async () => { d.querySelector("form")!.requestSubmit(); });
    await settle();
    expect(u.q("[role=alert]")?.textContent).toBe("Masala Tea has just sold out - take it off your order and try again.");
    expect(d.querySelector<HTMLInputElement>("#qo-name")!.value).toBe("Asha");
    expect(d.querySelector<HTMLInputElement>("#qo-detail")!.value).toBe("Bed 12");
  });

  it("places the order and waits on the checkout", async () => {
    const d = await openSheet();
    typeIn(d.querySelector<HTMLInputElement>("#qo-name")!, "Asha");
    typeIn(d.querySelector<HTMLInputElement>("#qo-phone")!, "9843022118");
    serve({ [PLACE]: () => json({ result: created(), changed: [], message: "Order placed." }) });
    await act(async () => { d.querySelector("form")!.requestSubmit(); });
    await settle();
    expect(ui!.button("Waiting for payment")).toBeDefined();
    expect((ui!.q<HTMLButtonElement>(".qo-pay"))!.disabled).toBe(true);
  });

  it("closes when the last line comes off", async () => {
    await openSheet();
    const d = ui!.q<HTMLDivElement>("[role=dialog]")!;
    click(d.querySelector("[aria-label='One less Masala Tea']")!);
    expect(ui!.q("[role=dialog]")).toBeNull();
  });
});

describe("the status page", () => {
  const at = `/order/${TOKEN}/o/QO-2026-0042`;
  async function show(order: PublicQrOrder, hash = `#k=${SECRET}`) {
    serve({ [STATUS]: () => json(order) });
    ui = await mount(`${at}${hash}`);
    return ui;
  }

  it("shows the number, the status, the path and the receipt", async () => {
    const u = await show(orderOf({ status: "Preparing" }));
    expect(u.q(".qo-no")?.getAttribute("aria-label")).toBe("Order number QO-2026-0042");
    expect(u.q(".qo-no strong")?.textContent).toBe("0042");
    expect(u.q("[aria-live=polite]")?.textContent).toBe(QR_STATUS_WORDS.Preparing);
    expect(u.text()).toContain("Collect it at the Coffee Shop counter");
    const steps = [...u.host.querySelectorAll(".qo-steps li")];
    expect(steps.map((s) => s.textContent)).toEqual(["Paid", "Preparing", "Ready", "Collected"]);
    expect(steps[0].className).toBe("is-done");
    expect(steps[1].getAttribute("aria-current")).toBe("step");
    expect(u.text()).toContain("Paid online");
    expect(u.text()).toContain("Bill CF/1200");
    expect(u.text()).toContain(istStamp("2026-09-24T08:31:00.000Z"));
    expect(u.text()).toContain("GST included");
    expect(u.text()).not.toContain("Discount");
    // The key came from the fragment, and the read carried it as ?k=.
    expect(String(fetchMock.mock.calls[0][0])).toContain(`?k=${SECRET}`);
    expect(document.title).toBe("Order QO-2026-0042");
    const print = vi.fn();
    vi.stubGlobal("print", print);
    window.print = print;
    click(u.button("Print"));
    expect(print).toHaveBeenCalled();
  });

  it("prints the IST time whatever the host's zone", () => {
    expect(istStamp("2026-09-24T20:00:00.000Z")).toBe("25-Sep-2026, 01:30");
  });

  it("says where a delivery goes, and shows a discount", async () => {
    const o = orderOf({ mode: "deliver", label: "Ward 3B", spot: "Bed 12", status: "Out for delivery", discount: 5, total: 35, steps: ["Paid", "Preparing", "Out for delivery", "Delivered"] });
    const u = await show(o);
    expect(u.text()).toContain("We'll bring it to Bed 12, Ward 3B.");
    expect(u.text()).toContain("Discount");
    expect(whereWords({ ...o, spot: "" })).toBe("We'll bring it to Ward 3B.");
  });

  it("explains a refund in each of its states", async () => {
    const u = await show(orderOf({ status: "Refunded", refund: { status: "Pending", amount: 40 } }));
    expect(u.q(".qo-ticket")?.className).toContain("is-off");
    expect(u.text()).toContain(QR_STATUS_WORDS.Refunded);
    expect(u.text()).toContain(`A refund of ${money(40)} is on its way`);
    expect(u.q(".qo-steps")).toBeNull();
    expect(refundWords(orderOf({ status: "Voided", refund: { status: "Processed", amount: 40 } }))).toContain("has been refunded");
    expect(refundWords(orderOf({ status: "Refunded", refund: { status: "Failed", amount: 40 } }))).toContain("needs a second try");
    expect(refundWords(orderOf({ status: "Voided", refund: null }))).toContain(`A refund of ${money(40)}`);
    expect(refundWords(orderOf({ status: "Expired" }))).toContain("Nothing was charged");
    expect(refundWords(orderOf())).toBeNull();
  });

  it("waits on a payment still going through, with the verify's sentence", async () => {
    usePublicOrder.setState({ statusNote: "We could not confirm your payment yet." });
    const u = await show(orderOf({ status: "Awaiting payment", paidAt: undefined, billNo: undefined }));
    expect(u.text()).toContain(QR_STATUS_WORDS["Awaiting payment"]);
    expect(u.text()).toContain("We could not confirm your payment yet.");
    expect(u.q(".qo-receipt")).toBeNull();
  });

  it("reads an expired order, with no receipt", async () => {
    const u = await show(orderOf({ status: "Expired", paidAt: undefined, billNo: undefined }));
    expect(u.text()).toContain(QR_STATUS_WORDS.Expired);
    expect(u.q(".qo-receipt")).toBeNull();
  });

  it("finds the key this phone kept when the link has none, and says so when it has none", async () => {
    localStorage.setItem("rch-qr-order", JSON.stringify({ orderId: "QO-2026-0042", secret: SECRET, token: TOKEN }));
    let u = await show(orderOf(), "");
    expect(u.text()).toContain(QR_STATUS_WORDS.Paid);
    u.unmount();
    localStorage.clear();
    resetPublicOrder();
    fetchMock.mockClear();
    u = ui = await show(orderOf(), "");
    expect(u.text()).toContain("This order link is incomplete");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers an unknown order and an outage", async () => {
    serve({ [STATUS]: () => json({ error: { code: "not_found", message: "Not found." } }, 404) });
    ui = await mount(`${at}#k=${SECRET}`);
    expect(ui.text()).toContain("Order not found");
    ui.unmount();
    resetPublicOrder();
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    ui = await mount(`${at}#k=${SECRET}`);
    expect(ui.text()).toContain("Could not load your order");
  });

  it("goes back to the menu without a reload", async () => {
    const u = await show(orderOf({ status: "Collected" }));
    serve({ [MENU]: () => json(menuOf()) });
    click(u.q("a[href]")!);
    await settle();
    expect(window.location.pathname).toBe(`/order/${TOKEN}`);
    expect(u.q("h1")?.textContent).toBe("Coffee Shop");
  });
});
