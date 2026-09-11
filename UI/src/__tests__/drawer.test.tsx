import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
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
