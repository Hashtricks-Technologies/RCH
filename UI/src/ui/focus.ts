import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

/**
 * The keyboard half of `role="dialog" aria-modal="true"`, written once.
 *
 * `aria-modal="true"` is a promise to a screen reader that nothing behind the panel is
 * reachable, and markup alone does not keep it: Tab walks straight out into the table
 * underneath, where every row is clickable and the scrim hides what has focus. Three pieces
 * make the promise true - the keyboard goes in on open, wraps at both ends while it is there,
 * and goes back where it came from on close - and they are the same three pieces whether the
 * panel slides in from the right (`Drawer`) or sits in the middle of the screen (`Modal`).
 * Both call `useFocusTrap`.
 */

/**
 * Everything a keyboard can reach inside the panel, in document order.
 *
 * Visibility is deliberately not part of the test. jsdom computes no layout, so `offsetParent`
 * and `getClientRects()` call every element hidden there, and a trap built on either would hold
 * nothing in the tests that exist to prove it holds. Disabled controls and `tabindex="-1"` are
 * both answerable from the markup alone, and they are what actually takes an element out of the
 * tab order here.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

/**
 * Put the keyboard back inside the panel, at the first control it can actually use - the title
 * only if there is no control at all, and the panel itself only if there is no title either.
 *
 * A no-op when focus is already inside, which is what makes it safe to call from anything that
 * merely *might* have let it out.
 */
const pullInto = (el: HTMLElement | null, titleId: string) => {
  if (!el || el.contains(document.activeElement)) return;
  const title = el.querySelector<HTMLElement>(`#${titleId}`);
  (el.querySelector<HTMLElement>(FOCUSABLE) ?? title ?? el).focus();
};

/**
 * Hold the keyboard inside `panel` while it is mounted, and hand it back on unmount.
 *
 * `at` identifies what the panel is currently showing: when it changes, the keyboard moves to
 * the panel's own title again, so the first thing read is what has just opened. `titleId` is
 * the id the panel puts on that heading - one per panel kind, because only one of each is ever
 * open at a time.
 *
 * Returns the `onKeyDown` the panel must spread onto its own element; the wrap cannot be done
 * from an effect, because it has to preventDefault on the Tab itself.
 */
export function useFocusTrap(
  panel: RefObject<HTMLElement | null>, at: string, titleId: string,
): (e: ReactKeyboardEvent<HTMLElement>) => void {
  // Where the keyboard was standing before the panel took it, and the two guards that keep it
  // from wandering off while the panel is open. All three live in one effect so the cleanup can
  // order them: the guards come **off first**, because restoring focus below is itself a focus
  // change and a guard still listening would catch its own restore and drag the keyboard back
  // into a panel that is going away.
  //
  // Focus is restored only if that element is still on the page - a row that has since been
  // re-rendered away cannot be handed focus, and forcing it would send the caret to the top of
  // the document instead.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;

    // `focusin` bubbles to the document, which is what catches the keyboard being *moved* out:
    // a click on the page behind, or a shortcut that focuses something in the shell.
    const guard = (e: FocusEvent) => {
      const el = panel.current;
      if (el && !el.contains(e.target as Node)) pullInto(el, titleId);
    };
    document.addEventListener("focusin", guard);

    // The other way the keyboard gets out, and the one `focusin` cannot see: the control holding
    // it stops being focusable. There are **two** ways that happens and both drop focus to
    // `<body>` firing no focus event at all, so nothing bubbles and no listener hears it - after
    // which the next Tab starts at the top of the document and walks the page behind the scrim,
    // exactly what `aria-modal="true"` promises cannot happen.
    //
    //  - It is **unmounted**: `roles/store/TicketDrawer.tsx`'s "Supervisor override" replaces
    //    itself with a confirm block.
    //  - It is **disabled** while it stands there: every busy button in the app does this, and
    //    the one the operator has just pressed is by definition the one holding the keyboard -
    //    `roles/buyer/PoReceiptDrawer.tsx`'s Book button and `roles/store/TicketDrawer.tsx`'s
    //    hand-over button among them. `childList` alone never sees it, because nothing moved.
    //
    // A render-time check cannot cover either: the state that swaps or disables those controls
    // lives in the panel's own body, so the panel never re-renders and no effect of its own
    // would run. The DOM is the only thing that reliably knows, so the DOM is what is watched -
    // `attributeFilter` keeps it to the one attribute that can take a control out of `FOCUSABLE`.
    const watcher = new MutationObserver(() => { pullInto(panel.current, titleId); });
    if (panel.current) {
      watcher.observe(panel.current, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    }

    return () => {
      watcher.disconnect();
      document.removeEventListener("focusin", guard);
      if (before?.isConnected) before.focus();
    };
  }, [panel, titleId]);

  // On open, and again whenever the same panel is pointed at a different document, the keyboard
  // moves to the panel's own title: the first thing read is what has just opened, and Tab from
  // there walks its controls in the order they are drawn.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const title = el.querySelector<HTMLElement>(`#${titleId}`);
    (title ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
  }, [panel, at, titleId]);

  // The stops are read at every keypress rather than once: a panel's controls come and go as
  // its data loads and its forms open, and a list captured on mount would trap against buttons
  // that are no longer there.
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab") return;
    const el = panel.current;
    if (!el) return;
    const stops = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (stops.length === 0) { e.preventDefault(); el.focus(); return; }
    // Backwards off the front, or forwards off the back, wraps to the other end. The title and
    // the panel itself are not stops (`-1`), so Shift+Tab standing on either counts as being off
    // the front, while a plain Tab from there falls through to the first control below it.
    const i = stops.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey ? i <= 0 : i === stops.length - 1) {
      e.preventDefault();
      (e.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
    }
  };
}
