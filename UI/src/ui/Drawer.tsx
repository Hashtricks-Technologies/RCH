import { useEffect } from "react";
import { useApp } from "../store";
import { DRAWERS } from "../drawers";
import { Btn } from "./kit";

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
    <>
      <div className="scrim" onClick={close} />
      <aside className="drawer" role="dialog" aria-modal="true">
        {Body ? <Body id={drawer.id} /> : (
          <>
            <div className="drh"><div className="dt"><h3>Not available</h3><p>{drawer.t}</p></div></div>
            <div className="drb" />
            <div className="drf"><Btn variant="gh" onClick={close}>Close</Btn></div>
          </>
        )}
      </aside>
    </>
  );
}

export function DrawerFrame({ title, sub, children, foot }: {
  title: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode; foot?: React.ReactNode;
}) {
  const close = useApp((s) => s.closeDrawer);
  return (
    <>
      <div className="drh">
        <div className="dt"><h3>{title}</h3>{sub && <p>{sub}</p>}</div>
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
