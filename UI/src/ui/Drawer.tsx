import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useApp } from "../store";
import { DRAWERS } from "../drawers";
import { useFocusTrap } from "./focus";
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
 * mount and an unmount - which is what makes the keyboard behave. `useFocusTrap` (`./focus.ts`)
 * is the keyboard half of `aria-modal="true"`, shared with `Modal`.
 */
function Panel({ at, onClose, children }: { at: string; onClose: () => void; children: ReactNode }) {
  const aside = useRef<HTMLElement>(null);
  const onKeyDown = useFocusTrap(aside, at, DRAWER_TITLE_ID);

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
