import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useFocusTrap } from "./focus";
import { Btn } from "./kit";

/**
 * A dialog box in the middle of the screen, for one short decision.
 *
 * The difference from a `Drawer` is what it is for, not how it looks. A drawer is a *document*
 * opened beside the list it came from - a ticket, a statement, an audit entry - and it stays
 * open while the operator reads it. This is a **form with one question and two answers**: name
 * the new price list, or don't. Nothing behind it needs reading while it is open, so it sits on
 * top of the page rather than beside it, and it is owned by the screen that raised it rather
 * than by the store's one drawer slot - two of these can never be open at once because only
 * one screen is.
 *
 * The keyboard half of `aria-modal="true"` is `useFocusTrap`, exactly as the drawer's is, and
 * Escape closes it. It is mounted only while it is open, so opening and closing are a mount and
 * an unmount - which is what makes focus go in and come back.
 */

/** The one id `aria-labelledby` points at. One is enough: only one modal is ever open, for the
 *  same reason only one drawer is. */
const MODAL_TITLE_ID = "modal-title";

export function Modal({ title, sub, onClose, foot, children }: {
  title: ReactNode; sub?: ReactNode; onClose: () => void; foot?: ReactNode; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const onKeyDown = useFocusTrap(box, String(title), MODAL_TITLE_ID);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="modal-wrap">
        <div
          ref={box} className="modal" role="dialog" aria-modal="true"
          aria-labelledby={MODAL_TITLE_ID} tabIndex={-1} onKeyDown={onKeyDown}
        >
          <div className="drh">
            {/* `tabIndex={-1}` so the keyboard can land here on open without adding a stop to
                the tab order: the title is read, and Tab still goes to the first real control. */}
            <div className="dt"><h3 id={MODAL_TITLE_ID} tabIndex={-1}>{title}</h3>{sub && <p>{sub}</p>}</div>
            <button className="ib" type="button" onClick={onClose} aria-label="Close">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
                <path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          </div>
          <div className="drb">{children}</div>
          <div className="drf">{foot ?? <Btn variant="gh" onClick={onClose}>Close</Btn>}</div>
        </div>
      </div>
    </>
  );
}
