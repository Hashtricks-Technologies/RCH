import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import Drawer, { DrawerFrame } from "../ui/Drawer";
import { registerDrawer } from "../drawers";
import { resetStore, S, as } from "./fixture";

/**
 * `role="dialog" aria-modal="true"` is a promise, and the drawer used to break it three ways at
 * once: the keyboard stayed on whatever opened the drawer, Tab walked out of the panel into the
 * table underneath — which the scrim had covered, so nobody could see what had focus — and
 * nothing named the dialog. These are the four things that make the promise true: a name, the
 * keyboard going in, the keyboard staying in, and the keyboard coming back.
 *
 * The drawer under test is a made-up one registered here rather than a real screen's, so the
 * tab order is exactly three stops and the assertions can name them.
 */
function TestDrawer({ id }: { id: string }) {
  return (
    <DrawerFrame title={`Ticket ${id}`} sub={id} foot={<button type="button">Hand over</button>}>
      <input aria-label="Collector code" />
    </DrawerFrame>
  );
}
registerDrawer("a11ytest", TestDrawer);

/**
 * A drawer with a control that **replaces itself**, which is the shape
 * `roles/store/TicketDrawer.tsx` uses for its supervisor override: pressing "Supervisor override"
 * swaps that button for a confirm block, so the element holding the keyboard stops existing. A
 * browser answers that by dropping focus to `<body>` and firing no focus event at all, so
 * nothing bubbles for a `focusin` guard to catch.
 */
function VanishingDrawer() {
  const [override, setOverride] = useState(false);
  return (
    <DrawerFrame title="Ticket TKT-2026-0451" foot={<button type="button">Close</button>}>
      {override ? (
        // A block, not another bare button: React reconciles by position, so two buttons in the
        // same slot would be the *same* DOM node re-labelled and nothing would unmount. The real
        // screen swaps a sentence-plus-button for two buttons, which does unmount; this is the
        // smallest shape with the same effect.
        <div><button type="button">Confirm override handover</button></div>
      ) : (
        <button type="button" onClick={() => setOverride(true)}>Supervisor override</button>
      )}
    </DrawerFrame>
  );
}
registerDrawer("a11yvanish", VanishingDrawer);

/**
 * A drawer with a control that **disables itself**, which is the shape every busy button in the
 * app uses — `roles/buyer/PoReceiptDrawer.tsx`'s Book button, `roles/store/TicketDrawer.tsx`'s
 * hand-over button. The button holding the keyboard is by definition the one just pressed, and a
 * browser that disables a focused control drops focus to `<body>` with no focus event fired, the
 * same silence an unmount leaves — but nothing in the DOM *moved*, so a `childList` watcher never
 * hears it either.
 *
 * The label is deliberately held constant, unlike the real buttons, which swap to "Booking in…"
 * as they disable. A changed label is a `childList` mutation inside the button and would wake the
 * watcher on its own — so the case would pass with `attributeFilter` removed and prove nothing.
 */
function BusyDrawer() {
  const [busy, setBusy] = useState(false);
  return (
    <DrawerFrame title="Goods receipt" foot={<button type="button">Close</button>}>
      <button type="button" disabled={busy} onClick={() => setBusy(true)}>Book into the central store</button>
    </DrawerFrame>
  );
}
registerDrawer("a11ybusy", BusyDrawer);

const stops = (host: HTMLElement) => ({
  close: host.querySelector<HTMLButtonElement>("button.ib")!,
  code: host.querySelector<HTMLInputElement>("input[aria-label=\"Collector code\"]")!,
  hand: [...host.querySelectorAll("button")].find((b) => b.textContent === "Hand over")!,
});

/** A Tab press from wherever the keyboard is standing. jsdom moves focus for nobody, so this is
 *  only ever meaningful about what the drawer's own handler does with the press. */
const tab = (shift = false) => {
  act(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true }),
    );
  });
};

describe("the drawer is a real dialog", () => {
  let host: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let opener: HTMLButtonElement;

  beforeEach(() => {
    resetStore();
    as("store");
    // Whatever had the keyboard before the drawer opened — a row in the table behind it.
    opener = document.createElement("button");
    opener.textContent = "TKT-2026-0451";
    document.body.appendChild(opener);
    opener.focus();

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root.render(createElement(Drawer)); });
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    opener.remove();
    act(() => { S().closeDrawer(); });
  });

  const open = (id = "TKT-2026-0451") => { act(() => { S().openDrawer("a11ytest", id); }); };

  it("names itself, so a screen reader says which drawer opened", () => {
    open();
    const dialog = host.querySelector<HTMLElement>("aside.drawer")!;
    const labelledBy = dialog.getAttribute("aria-labelledby")!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(host.querySelector(`#${labelledBy}`)!.textContent).toBe("Ticket TKT-2026-0451");
  });

  it("puts the keyboard inside the drawer on open, at its title", () => {
    open();
    const title = host.querySelector<HTMLElement>("h3#drawer-title")!;
    expect(document.activeElement).toBe(title);
  });

  it("wraps Tab off the last control back to the first", () => {
    open();
    const { close, hand } = stops(host);
    act(() => { hand.focus(); });

    tab();

    expect(document.activeElement).toBe(close);
  });

  it("wraps Shift+Tab off the first control back to the last", () => {
    open();
    const { close, hand } = stops(host);
    act(() => { close.focus(); });

    tab(true);

    expect(document.activeElement).toBe(hand);
  });

  it("lets Tab through in the middle of the drawer, where there is nothing to trap", () => {
    open();
    const { code } = stops(host);
    act(() => { code.focus(); });

    tab();

    // Untouched: the browser's own Tab moves on from here, and jsdom's does not move at all.
    expect(document.activeElement).toBe(code);
  });

  /**
   * The case a `focusin` guard alone cannot see. Pressing "Supervisor override" replaces the
   * pressed button with a confirm block, so the element holding the keyboard stops existing and
   * focus falls to `<body>` — outside the dialog, with no focus event fired. Left there, the next
   * Tab starts at the top of the document and walks the page behind the scrim, which is precisely
   * what `aria-modal="true"` promises cannot happen.
   */
  it("pulls focus back into the panel when the focused control unmounts", async () => {
    act(() => { S().openDrawer("a11yvanish", "TKT-2026-0451"); });
    const override = [...host.querySelectorAll("button")].find((b) => b.textContent === "Supervisor override")!;
    act(() => { override.focus(); });
    expect(document.activeElement).toBe(override);

    // `await`, because the DOM watcher answers on a microtask — one turn in which focus sits on
    // `<body>`, and no input can happen. A browser gets the same turn.
    await act(async () => { override.click(); });

    expect(override.isConnected).toBe(false);           // it really did replace itself
    const aside = host.querySelector<HTMLElement>("aside.drawer")!;
    expect(document.activeElement).not.toBe(document.body);
    expect(aside.contains(document.activeElement)).toBe(true);
  });

  it("pulls focus back when the focused control becomes disabled", async () => {
    act(() => { S().openDrawer("a11ybusy", "PO-2026-0143"); });
    const book = [...host.querySelectorAll("button")].find((b) => b.textContent === "Book into the central store")!;
    act(() => { book.focus(); });
    expect(document.activeElement).toBe(book);

    await act(async () => {
      book.click();                                    // React commits `disabled` on this press
      book.blur();                                     // what a browser does the instant it lands;
      //                                                  jsdom does not, so the test does it here
    });

    expect(book.disabled).toBe(true);                  // it really did disable itself
    expect(book.isConnected).toBe(true);               // and nothing unmounted, so `childList` is silent
    const aside = host.querySelector<HTMLElement>("aside.drawer")!;
    expect(document.activeElement).not.toBe(document.body);
    expect(aside.contains(document.activeElement)).toBe(true);
  });

  it("pulls focus back when something outside the drawer takes it", () => {
    open();
    const aside = host.querySelector<HTMLElement>("aside.drawer")!;

    act(() => { opener.focus(); });                     // a control on the page behind the scrim

    expect(document.activeElement).toBe(stops(host).close);
    expect(aside.contains(document.activeElement)).toBe(true);
  });

  it("gives the keyboard back to whatever opened the drawer", () => {
    open();
    expect(document.activeElement).not.toBe(opener);

    act(() => { S().closeDrawer(); });

    expect(document.activeElement).toBe(opener);
  });

  it("still closes on Escape", () => {
    open();

    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });

    expect(S().drawer).toBeNull();
    expect(host.querySelector("aside.drawer")).toBeNull();
  });

  it("re-reads the title when the same drawer is pointed at another document", () => {
    open();
    const { hand } = stops(host);
    act(() => { hand.focus(); });

    act(() => { S().openDrawer("a11ytest", "TKT-2026-0452"); });

    const title = host.querySelector<HTMLElement>("h3#drawer-title")!;
    expect(title.textContent).toBe("Ticket TKT-2026-0452");
    expect(document.activeElement).toBe(title);
  });
});
