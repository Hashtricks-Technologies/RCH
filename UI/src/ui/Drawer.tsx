import { useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useApp } from "../store";
import { DRAWERS } from "../drawers";
import { Btn } from "./kit";

/**
 * The one id the dialog's `aria-labelledby` points at.
 *
 * One id is enough because one drawer is all there ever is: `drawer` in the store is a single
 * slot, not a stack. `DrawerFrame` is the only thing that may put it on a heading, so a screen
 * reader entering the dialog reads the drawer's own title and not "dialog" on its own - and
 * `DrawerFrame` lives in this file, which is why this is not exported.
 */
const DRAWER_TITLE_ID = "drawer-title";

/**
 * Everything a keyboard can reach inside the drawer, in document order.
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
const pullInto = (el: HTMLElement | null) => {
  if (!el || el.contains(document.activeElement)) return;
  const title = el.querySelector<HTMLElement>(`#${DRAWER_TITLE_ID}`);
  (el.querySelector<HTMLElement>(FOCUSABLE) ?? title ?? el).focus();
};

export default function Drawer() {
  const drawer = useApp((s) => s.drawer);
  const close = useApp((s) => s.closeDrawer);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [close]);
  if (!drawer) return null;
  const Body = DRAWERS[drawer.t];
  return (
    <Panel at={`${drawer.t}:${drawer.id}`} onClose={close}>
      {Body ? <Body id={drawer.id} /> : (
        <>
          <div className="drh"><div className="dt"><h3 id={DRAWER_TITLE_ID} tabIndex={-1}>Not available</h3><p>{drawer.t}</p></div></div>
          <div className="drb" />
          <div className="drf"><Btn variant="gh" onClick={close}>Close</Btn></div>
        </>
      )}
    </Panel>
  );
}

/**
 * The dialog itself, mounted only while a drawer is open so that opening and closing are a
 * mount and an unmount - which is what makes the keyboard behave.
 *
 * `role="dialog" aria-modal="true"` is a promise to a screen reader that nothing behind this is
 * reachable, and until this landed the markup said it while the keyboard did the opposite: Tab
 * walked straight out of the panel and into the table underneath, where every row is clickable
 * and the drawer's own scrim hid what had focus. Three pieces make the promise true - the
 * keyboard goes in on open, wraps at both ends while it is there, and goes back where it came
 * from on close.
 */
function Panel({ at, onClose, children }: { at: string; onClose: () => void; children: ReactNode }) {
  const aside = useRef<HTMLElement>(null);

  // Where the keyboard was standing before the drawer took it, and the two guards that keep it
  // from wandering off while the drawer is open. All three live in one effect so the cleanup can
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
      const el = aside.current;
      if (el && !el.contains(e.target as Node)) pullInto(el);
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
    // lives in the drawer's own body, so `Panel` never re-renders and no effect of `Panel`'s
    // would run. The DOM is the only thing that reliably knows, so the DOM is what is watched -
    // `attributeFilter` keeps it to the one attribute that can take a control out of `FOCUSABLE`.
    const watcher = new MutationObserver(() => { pullInto(aside.current); });
    if (aside.current) {
      watcher.observe(aside.current, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    }

    return () => {
      watcher.disconnect();
      document.removeEventListener("focusin", guard);
      if (before?.isConnected) before.focus();
    };
  }, []);

  // On open, and again whenever the same panel is pointed at a different document, the keyboard
  // moves to the drawer's own title: the first thing read is what has just opened, and Tab from
  // there walks the drawer's controls in the order they are drawn.
  useEffect(() => {
    const el = aside.current;
    if (!el) return;
    const title = el.querySelector<HTMLElement>(`#${DRAWER_TITLE_ID}`);
    (title ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
  }, [at]);

  // The stops are read at every keypress rather than once: a drawer's controls come and go as
  // its data loads and its forms open, and a list captured on mount would trap against buttons
  // that are no longer there.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab") return;
    const el = aside.current;
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

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside
        ref={aside} className="drawer" role="dialog" aria-modal="true"
        aria-labelledby={DRAWER_TITLE_ID} tabIndex={-1} onKeyDown={onKeyDown}
      >
        {children}
      </aside>
    </>
  );
}

export function DrawerFrame({ title, sub, children, foot }: {
  title: ReactNode; sub?: ReactNode; children: ReactNode; foot?: ReactNode;
}) {
  const close = useApp((s) => s.closeDrawer);
  return (
    <>
      <div className="drh">
        {/* `tabIndex={-1}` so the drawer can put the keyboard here on open without adding a stop
            to the tab order: the title is read, and Tab still goes to the first real control. */}
        <div className="dt"><h3 id={DRAWER_TITLE_ID} tabIndex={-1}>{title}</h3>{sub && <p>{sub}</p>}</div>
        <button className="ib" type="button" onClick={close} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
            <path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      <div className="drb">{children}</div>
      <div className="drf">{foot ?? <Btn variant="gh" onClick={close}>Close</Btn>}</div>
    </>
  );
}
